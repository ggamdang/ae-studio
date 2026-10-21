"""Offline PDF/A conversion/validation and PKCS#12 certificate signatures.

Called by engine.run after its path checks and fresh Job creation. Secrets stay
in memory. Java and LibreOffice receive no password arguments. No networking,
certificate issuance, public trust claim, or in-place document mutation occurs.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / "runtime" / "archive"
ACTIONS = {"pdfa", "validate-pdfa", "certificate-sign", "verify-signature"}
CONVERT_PROFILES = {"1b": 1, "2b": 2, "3b": 3}
VALIDATE_PROFILES = {"auto", "1a", "1b", "2a", "2b", "2u", "3a", "3b", "3u", "4", "4e", "4f"}


def _engine():
    # The worker also runs as a script, where importing engine would create a
    # second PdfError class. Use the running module in that case.
    main = sys.modules.get("__main__")
    if main is not None and hasattr(main, "PdfError") and hasattr(main, "Job"):
        return main
    import engine
    return engine


def _error(code, message):
    raise _engine().PdfError(code, message)


def _require(condition, message, code="INVALID_OPTIONS"):
    if not condition:
        _error(code, message)


def _java():
    return next((RUNTIME / "java").glob("*/bin/java.exe" if os.name == "nt" else "*/Contents/Home/bin/java"), None)


def archive_capabilities():
    validator = _java() is not None and (RUNTIME / "verapdf" / "bin").is_dir()
    signer = (RUNTIME / "site-packages" / "pyhanko" / "sign" / "signers").is_dir()
    office = _engine().find_office() is not None
    return {"actions": {"pdfa": validator and office, "validate-pdfa": validator,
                        "certificate-sign": signer, "verify-signature": signer},
            "pdfa": {"available": validator and office, "profiles": list(CONVERT_PROFILES),
                     "validator": "veraPDF 1.28.2", "validationRequired": True},
            "signing": {"available": signer, "engine": "pyHanko 0.37.0", "format": "PKCS#12 (.p12/.pfx)",
                        "offline": True, "certificateIssuance": False,
                        "trust": "Only explicitly supplied local trust roots; no online revocation or timestamp service."}}


def _cancel(job):
    check = getattr(job, "check_cancelled", None)
    if callable(check):
        check()
    if getattr(job, "cancelled", False) is True:
        _error("CANCELLED", "The PDF operation was cancelled; the original was not changed.")


def _run_process(args, job, timeout=180, cwd=None):
    """Bounded child process; bridge cancellation can terminate its whole tree."""
    _cancel(job)
    environment = os.environ.copy()
    # JVM injection variables must not activate an agent or external service.
    for key in ("JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"):
        environment.pop(key, None)
    process = subprocess.Popen([str(v) for v in args], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               shell=False, cwd=cwd, env=environment,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    deadline = time.monotonic() + timeout
    try:
        while True:
            _cancel(job)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _error("TIMEOUT", "The local archive tool exceeded its time limit; the original was not changed.")
            try:
                stdout, _ = process.communicate(timeout=min(0.25, remaining))
                _require(len(stdout) <= 16 * 1024 * 1024, "The validation report exceeded the size limit.", "REPORT_TOO_LARGE")
                return process.returncode, stdout
            except subprocess.TimeoutExpired:
                continue
    finally:
        if process.poll() is None:
            _engine().stop_process_tree(process)
            process.communicate(timeout=10)


def _sha(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _json_report(job, name, details):
    target = job.target(name)
    target.write_text(json.dumps(details, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    job.add(target)
    return target


def _validate_pdfa(path, profile, job):
    java = _java()
    _require(java is not None and (RUNTIME / "verapdf" / "bin").is_dir(),
             "The bundled veraPDF validator is missing.", "CAPABILITY_UNAVAILABLE")
    _require(profile in VALIDATE_PROFILES, "Choose an available PDF/A validation profile.")
    base = RUNTIME / "verapdf"
    args = [java, "-Xmx768m", "-Dfile.encoding=UTF8", "-Djava.awt.headless=true",
            "-classpath", str(base / "etc") + os.pathsep + str(base / "bin" / "*"),
            "org.verapdf.apps.GreenfieldCliWrapper", "--format", "xml", "--flavour",
            "0" if profile == "auto" else profile, "--maxfailuresdisplayed", "5", str(path)]
    code, raw = _run_process(args, job, cwd=base)
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        _error("VALIDATION_FAILED", "veraPDF could not produce a readable conformance report for this PDF.")
    reports = root.findall(".//validationReport")
    batch = root.find(".//batchSummary")
    # veraPDF exits 1 for a completed, non-conformant document (not a crash).
    _require(code in (0, 1) and len(reports) == 1 and batch is not None,
             "veraPDF could not completely validate this PDF.", "VALIDATION_FAILED")
    _require(all(int(batch.get(k, "0")) == 0 for k in ("failedToParse", "encrypted", "outOfMemory", "veraExceptions")),
             "veraPDF could not parse this PDF as an unencrypted archival document.", "VALIDATION_FAILED")
    report = reports[0]
    _require(report.get("jobEndStatus", "normal") == "normal",
             "veraPDF did not finish all conformance checks.", "VALIDATION_FAILED")
    failures = []
    for rule in report.findall(".//rule"):
        if rule.get("status") == "failed":
            failures.append({"specification": rule.get("specification"), "clause": rule.get("clause"),
                             "test": rule.get("testNumber"),
                             "description": (rule.findtext("description") or "").strip()[:1500]})
    counts = report.find("details")
    details = {"conforms": report.get("isCompliant") == "true", "profile": report.get("profileName"),
               "requestedProfile": profile, "validator": "veraPDF", "validatorVersion": "1.28.2",
               "sha256": _sha(path), "failedRules": int(counts.get("failedRules", "0")) if counts is not None else None,
               "failedChecks": int(counts.get("failedChecks", "0")) if counts is not None else None,
               "failures": failures[:50]}
    details["summary"] = ("Passed " if details["conforms"] else "Does not conform to ") + (details["profile"] or "PDF/A validation") + "."
    return details, raw


def _pdfa(action, path, options, job, password):
    import pikepdf
    engine = _engine()
    warnings = []
    profile = options.get("profile", "2b" if action == "pdfa" else "auto")
    allowed = CONVERT_PROFILES if action == "pdfa" else VALIDATE_PROFILES
    _require(isinstance(profile, str) and profile in allowed, "Choose an available PDF/A profile.")
    with engine.open_pdf(path, password) as original:
        original_pages = len(original)
        original_sizes = [(p.rect.width, p.rect.height) for p in original]
    if action == "validate-pdfa":
        # Validating a decrypted rewrite would validate a different artifact.
        with pikepdf.open(path, password=password) as check:
            _require(not check.is_encrypted, "Encrypted PDFs cannot conform to PDF/A. Use PDF/A conversion to create an unencrypted archival copy.", "PDFA_ENCRYPTED")
        details, raw = _validate_pdfa(path, profile, job)
    else:
        office = engine.find_office()
        _require(office.is_file(), "The bundled LibreOffice converter is missing.", "CAPABILITY_UNAVAILABLE")
        # LibreOffice creates deep profile trees. The bridge supplies a private
        # worker TEMP root and cleans it on cancellation; do not nest in the
        # potentially long user output path.
        with tempfile.TemporaryDirectory(prefix="us-a-") as temp:
            scratch = Path(temp)
            source = scratch / "source.pdf"
            with pikepdf.open(path, password=password) as pdf:
                encrypted = pdf.is_encrypted
                signed = any(getattr(field, "FT", None) == "/Sig" for field in pdf.Root.get("/AcroForm", {}).get("/Fields", []))
                if encrypted:
                    pdf.save(source)
                else:
                    shutil.copyfile(path, source)
            outdir, office_profile = scratch / "converted", scratch / "profile"
            outdir.mkdir()
            (office_profile / "user").mkdir(parents=True)
            settings = ('<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
                        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
                        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
                        '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>'
                        '<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>'
                        '</item>'
                        '<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>'
                        '<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>'
                        '</oor:items>')
            (office_profile / "user" / "registrymodifications.xcu").write_text(settings, encoding="utf-8")
            filters = {"SelectPdfVersion": {"type": "long", "value": str(CONVERT_PROFILES[profile])},
                       "UseLosslessCompression": {"type": "boolean", "value": "true"},
                       "ExportFormFields": {"type": "boolean", "value": "false"},
                       "ExportBookmarks": {"type": "boolean", "value": "true"}}
            args = [office, f"-env:UserInstallation={office_profile.as_uri()}", "--headless", "--nologo", "--nodefault",
                    "--norestore", "--nofirststartwizard", "--convert-to",
                    "pdf:draw_pdf_Export:" + json.dumps(filters, separators=(",", ":")), "--outdir", outdir, source]
            code, _ = _run_process(args, job)
            candidate = outdir / "source.pdf"
            _require(code == 0 and candidate.is_file(), "LibreOffice could not create an archival candidate from this PDF.", "CONVERSION_FAILED")
            with engine.open_pdf(candidate) as result:
                _require(len(result) == original_pages, "Archival conversion changed the page count. No output was accepted.", "CONVERSION_FAILED")
                _require(all(abs(p.rect.width - size[0]) <= 2 and abs(p.rect.height - size[1]) <= 2
                             for p, size in zip(result, original_sizes)),
                         "Archival conversion changed page dimensions. No output was accepted.", "CONVERSION_FAILED")
            details, raw = _validate_pdfa(candidate, profile, job)
            if not details["conforms"]:
                issues = "; ".join(f"{r['clause']}: {r['description'][:160]}" for r in details["failures"][:3])
                if any(r.get("clause") == "6.2.11.5" for r in details["failures"]):
                    _error("PDFA_NONCOMPLIANT", "The converted copy's embedded font widths failed PDF/A validation. Try exporting a new PDF from the original document and converting that copy. No archival output was accepted; the original is unchanged.")
                _error("PDFA_NONCOMPLIANT", "The converted copy failed veraPDF conformance checks; no PDF/A output was accepted. " + issues)
            target = job.target(f"archive-pdfa-{profile}.pdf")
            shutil.copyfile(candidate, target)
            job.add(target)
            if encrypted:
                warnings.append("The archival copy is unencrypted because PDF/A does not permit encryption.")
            if signed:
                warnings.append("Conversion removes existing certificate signatures from the archival copy. Keep the signed original.")
        warnings.append("PDF/A conversion re-renders pages with LibreOffice. Review fonts and layout; forms, links and signatures may change. A conformance pass is not a visual-fidelity guarantee.")
        details["pageCount"] = original_pages
        details["sourceSha256"] = _sha(path)
    # Keep the validator's full report as evidence. Remove scratch-path leakage.
    xml_target = job.target("pdfa-verapdf-report.xml")
    xml_target.write_bytes(raw)
    job.add(xml_target)
    _json_report(job, "pdfa-summary.json", details)
    if not details["conforms"]:
        warnings.append("This file did not pass PDF/A validation. The reports do not certify it as an archival PDF.")
    return {"details": details, "warnings": warnings}


def _signing_imports():
    package_path = str(RUNTIME / "site-packages")
    if package_path not in sys.path:
        sys.path.insert(0, package_path)
    try:
        from pyhanko.sign import signers
        from pyhanko.pdf_utils.reader import PdfFileReader
        from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
        from pyhanko.sign.validation import validate_pdf_signature
        from pyhanko_certvalidator import ValidationContext
        from pyhanko.keys import load_certs_from_pemder
    except ImportError:
        _error("CAPABILITY_UNAVAILABLE", "The bundled certificate-signing libraries are missing or incompatible.")
    return signers, PdfFileReader, IncrementalPdfFileWriter, validate_pdf_signature, ValidationContext, load_certs_from_pemder


def _trust(options, loader):
    paths = options.get("trustCertificatePaths", [])
    _require(isinstance(paths, list) and len(paths) <= 20, "Choose at most 20 local trusted certificate files.")
    roots = []
    for value in paths:
        path = _engine().checked_path(value, {".pem", ".crt", ".cer"})
        _require(path.stat().st_size <= 2 * 1024 * 1024, "A certificate file may contain at most 2 MB.")
        try:
            roots.extend(loader([str(path)]))
        except Exception:
            _error("INVALID_CERTIFICATE", "A selected trust certificate could not be read as PEM or DER.")
    _require(len(roots) <= 100, "The selected files contain too many trust certificates.")
    return roots


def _cert_details(cert):
    from cryptography import x509
    self_signed = False
    if cert.self_issued:
        try:
            parsed = x509.load_der_x509_certificate(cert.dump())
            parsed.verify_directly_issued_by(parsed)
            self_signed = True
        except Exception:
            pass
    return {"subject": cert.subject.human_friendly, "issuer": cert.issuer.human_friendly,
            "serialNumber": str(cert.serial_number), "sha256": hashlib.sha256(cert.dump()).hexdigest(),
            "selfSigned": self_signed, "selfIssued": bool(cert.self_issued),
            "notBefore": cert.not_valid_before.isoformat(), "notAfter": cert.not_valid_after.isoformat()}


def _verify(path, password, roots, job):
    _, Reader, _, validate, Context, _ = _signing_imports()
    results = []
    try:
        with open(path, "rb") as stream:
            reader = Reader(stream, strict=True)
            if reader.encrypted:
                auth = reader.decrypt(password)
                _require(auth.status.name != "FAILED", "Enter the correct PDF opening password.", "PASSWORD_REQUIRED")
            signatures = reader.embedded_signatures
            _require(len(signatures) <= 100, "This document contains too many signatures to validate.")
            for signature in signatures:
                _cancel(job)
                info = {"fieldName": signature.field_name, "certificate": _cert_details(signature.signer_cert)}
                try:
                    # Explicit empty roots prevent implicit system/browser trust.
                    context = Context(trust_roots=roots, allow_fetching=False, revocation_mode="soft-fail")
                    status = validate(signature, signer_validation_context=context, ts_validation_context=context)
                    coverage = status.coverage.name if status.coverage is not None else "UNKNOWN"
                    modification = status.modification_level.name if status.modification_level is not None else "UNKNOWN"
                    info.update({"intact": bool(status.intact), "cryptographicallyValid": bool(status.valid),
                                 "integrityValid": bool(status.intact and status.valid),
                                 "coversWholeFile": coverage == "ENTIRE_FILE", "coverage": coverage,
                                 "modificationLevel": modification, "documentPermissionsOkay": bool(status.docmdp_ok),
                                 "trustedBySuppliedRoots": bool(roots and status.trusted),
                                 "revocationStatus": "not_checked_online", "onlineChecksPerformed": False,
                                 "signingTime": status.signer_reported_dt.isoformat() if status.signer_reported_dt else None,
                                 "signingTimeVerified": False})
                    info["status"] = ("INVALID" if not info["integrityValid"] or not status.docmdp_ok else
                                      "DOCUMENT_CHANGED" if not info["coversWholeFile"] else
                                      "INTACT_TRUSTED_LOCALLY" if info["trustedBySuppliedRoots"] else "INTACT_TRUST_NOT_ESTABLISHED")
                except Exception as exc:
                    if isinstance(exc, _engine().PdfError):
                        raise
                    # Do not echo parser exceptions, which may contain document data.
                    info.update({"status": "VALIDATION_ERROR", "intact": False, "cryptographicallyValid": False,
                                 "integrityValid": False, "trustedBySuppliedRoots": False,
                                 "error": "This signature could not be validated; it may be malformed or use an unsupported algorithm."})
                results.append(info)
    except Exception as exc:
        if isinstance(exc, _engine().PdfError):
            raise
        _error("INVALID_PDF", "The signed PDF could not be parsed safely; it may be malformed or damaged.")
    all_intact = bool(results) and all(r.get("integrityValid") and r.get("coversWholeFile") and r.get("documentPermissionsOkay") for r in results)
    details = {"engine": "pyHanko", "engineVersion": "0.37.0", "sha256": _sha(path),
               "signatureCount": len(results), "signatures": results, "allSignaturesIntactAndCurrent": all_intact,
               "trustRootsSupplied": len(roots), "revocationStatus": "not_checked_online", "offline": True}
    if not results:
        details["summary"] = "No certificate signatures were found in this PDF."
    elif any(r["status"] in {"INVALID", "VALIDATION_ERROR"} for r in results):
        details["summary"] = "One or more certificate signatures are invalid or could not be verified."
    elif not all_intact:
        details["summary"] = "Signature integrity is intact, but the document contains changes after a signature. Review each signature report."
    elif all(r.get("trustedBySuppliedRoots") for r in results):
        details["summary"] = "Signature integrity passed and certificate trust matched the roots you supplied. Online revocation was not checked."
    else:
        details["summary"] = "Signature integrity passed. Signer trust is not established; online revocation was not checked."
    return details


def _text(options, name, default="", limit=250):
    value = options.get(name, default)
    _require(isinstance(value, str) and len(value) <= limit and "\x00" not in value, f"{name} must be text of at most {limit} characters.")
    return value


def _certificate_sign(path, options, job, password):
    signers, _, Writer, _, _, loader = _signing_imports()
    certificate = _engine().checked_path(options.get("certificatePath"), {".p12", ".pfx"})
    _require(certificate.stat().st_size <= 10 * 1024 * 1024, "A signing certificate file may contain at most 10 MB.")
    cert_password = _text(options, "certificatePassword", limit=1024)
    field_name = _text(options, "fieldName", "StudioSignature", 100)
    _require(bool(field_name) and "." not in field_name and not any(ord(v) < 32 for v in field_name), "Choose a nonempty signature field name without dots or control characters.")
    roots = _trust(options, loader)
    try:
        signer = signers.SimpleSigner.load_pkcs12(str(certificate), passphrase=cert_password.encode("utf-8") if cert_password else None)
    except Exception:
        signer = None
    _require(signer is not None, "The PKCS#12 certificate or its password could not be read. Supply a .p12/.pfx containing your private signing key.", "CERTIFICATE_PASSWORD_OR_FORMAT")
    cert = _cert_details(signer.signing_cert)
    now = datetime.now(timezone.utc)
    _require(signer.signing_cert.not_valid_before <= now <= signer.signing_cert.not_valid_after,
             "The signing certificate is not currently valid (expired or not yet valid).", "CERTIFICATE_DATE_INVALID")
    _cancel(job)
    target = job.target("certificate-signed.pdf")
    try:
        with open(path, "rb") as source, open(target, "xb") as destination:
            writer = Writer(source, strict=True)
            if writer.prev.encrypted:
                auth = writer.encrypt(password)
                _require(auth.status.name != "FAILED", "Enter the correct PDF opening password.", "PASSWORD_REQUIRED")
            metadata = signers.PdfSignatureMetadata(field_name=field_name, md_algorithm="sha256",
                                                    reason=_text(options, "reason") or None,
                                                    location=_text(options, "location") or None)
            # No network timestamp, revocation fetching, or automatic trust roots.
            signers.sign_pdf(writer, metadata, signer=signer, output=destination)
    except Exception as exc:
        if isinstance(exc, _engine().PdfError):
            raise
        _error("SIGNING_FAILED", "Certificate signing failed. The signature field may already be signed, or the certificate/PDF may not support this operation.")
    _cancel(job)
    details = _verify(target, password, roots, job)
    signed = next((s for s in details["signatures"] if s["fieldName"] == field_name), None)
    _require(signed is not None and signed.get("integrityValid") and signed.get("coversWholeFile") and signed.get("documentPermissionsOkay"),
             "The newly signed copy did not pass cryptographic verification. No signed output was accepted.", "SIGNATURE_SELF_CHECK_FAILED")
    details["sourceSha256"] = _sha(path)
    details["signingCertificate"] = cert
    details["summary"] = "Created a certificate signature and verified its integrity. " + ("Self-signed certificate: test/demo only; public identity trust is not established." if cert["selfSigned"] else "Trust depends on your certificate and the verifier's trust policy.")
    job.add(target)
    _json_report(job, "signature-verification.json", details)
    warnings = ["The certificate signature is cryptographic and may be invisible on the page. No trusted timestamp or online revocation check was requested; the displayed signing time is signer-reported."]
    if cert["selfSigned"]:
        warnings.append("SELF-SIGNED CERTIFICATE - test/demo only. A valid cryptographic signature does not independently establish the signer's identity.")
    if not signed.get("trustedBySuppliedRoots"):
        warnings.append("Certificate trust is not established. Verification used only explicitly supplied local trust roots.")
    return {"details": details, "warnings": warnings}


def run_archive(action, files, options, job, password=""):
    """Return details/warnings and register outputs on an existing engine.Job."""
    _require(action in ACTIONS, "Unsupported archive/signature action.", "UNKNOWN_ACTION")
    _require(isinstance(options, dict) and len(files) == 1, "Select one PDF for archive/signature processing.")
    _require(isinstance(password, str) and len(password) <= 1024, "The PDF password must be text of at most 1024 characters.")
    path = _engine().checked_path(str(files[0]), {".pdf"})
    _cancel(job)
    if action in {"pdfa", "validate-pdfa"}:
        return _pdfa(action, path, options, job, password)
    if action == "certificate-sign":
        return _certificate_sign(path, options, job, password)
    *_, loader = _signing_imports()
    details = _verify(path, password, _trust(options, loader), job)
    _json_report(job, "signature-verification.json", details)
    return {"details": details,
            "warnings": ["Offline verification separates document integrity from certificate trust. Revocation and a trusted signing time were not checked online."]}
