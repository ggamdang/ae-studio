"""Integration checks for local archival/signature features. No real credentials.

Run with runtime/python.exe archive_test.py. All credentials are ephemeral test
fixtures, deleted with their temporary directory. Outputs are test evidence.
"""
from pathlib import Path
import hashlib
import json
import sys
import shutil
import tempfile
import unittest
import logging
from unittest.mock import patch
from datetime import datetime, timezone, timedelta

import engine
import advanced_archive as archive
import pymupdf as fitz

archive._signing_imports()
logging.disable(logging.CRITICAL)
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID


class ArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="archive-tests-", dir=Path(__file__).parent)
        cls.root = Path(cls.tmp.name)
        cls.source = cls.root / "source.pdf"
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 80), "ARCHIVE TEST - ORIGINAL CONTENT", fontsize=20)
        page.insert_text((60, 120), "Two colored shapes, plain text, and a second page.")
        page.draw_rect(fitz.Rect(60, 160, 240, 260), color=(0, .3, .6), fill=(.8, .9, 1))
        page.draw_circle((360, 210), 50, color=(.6, .1, .1), fill=(1, .8, .8))
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 80), "SECOND PAGE", fontsize=20)
        doc.save(cls.source, deflate=False)
        doc.close()
        cls.original_hash = archive._sha(cls.source)
        cls.p12 = cls.root / "TEST_ONLY_SELF_SIGNED.p12"
        cls.trust = cls.root / "TEST_ONLY_SELF_SIGNED.pem"
        cls.passphrase = "Test-only-secret-93847!"
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "UNIFIED STUDIO TEST ONLY - NOT A TRUSTED IDENTITY")])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=7))
                .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                                            data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                            crl_sign=True, encipher_only=None, decipher_only=None), critical=True)
                .sign(key, hashes.SHA256()))
        cls.p12.write_bytes(pkcs12.serialize_key_and_certificates(b"TEST ONLY", key, cert, None,
                                                                serialization.BestAvailableEncryption(cls.passphrase.encode())))
        cls.trust.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        cls.signed = cls.call("certificate-sign", {"certificatePath": str(cls.p12), "certificatePassword": cls.passphrase})
        cls.signed_path = Path(cls.signed["outputs"][0]["path"])

    @classmethod
    def tearDownClass(cls):
        assert archive._sha(cls.source) == cls.original_hash
        cls.tmp.cleanup()

    @classmethod
    def call(cls, action, options=None, source=None, password=""):
        job = engine.Job(str(cls.root), action)
        try:
            result = archive.run_archive(action, [source or cls.source], options or {}, job, password)
            result["outputs"] = job.outputs
            return result
        except BaseException:
            job.cleanup_failed()
            raise

    def test_sign_and_verify_without_assumed_trust(self):
        detail = self.signed["details"]
        sig = detail["signatures"][0]
        self.assertTrue(sig["integrityValid"])
        self.assertTrue(sig["coversWholeFile"])
        self.assertFalse(sig["trustedBySuppliedRoots"])
        self.assertTrue(detail["signingCertificate"]["selfSigned"])
        self.assertIn("test/demo", detail["summary"])
        for output in self.signed["outputs"]:
            self.assertNotIn(self.passphrase.encode(), Path(output["path"]).read_bytes())

    def test_explicit_local_trust(self):
        r = self.call("verify-signature", {"trustCertificatePaths": [str(self.trust)]}, self.signed_path)
        self.assertTrue(r["details"]["signatures"][0]["trustedBySuppliedRoots"])
        self.assertEqual(r["details"]["revocationStatus"], "not_checked_online")

    def test_tamper_is_detected(self):
        payload = self.signed_path.read_bytes()
        # Change a covered byte in page text while preserving PDF structure/length.
        marker = b"0 .3 .6 RG .8 .9 1 rg B"  # Uncompressed shape paint operation.
        self.assertTrue(marker in payload)
        bad = self.root / "tampered.pdf"
        bad.write_bytes(payload.replace(marker, b"1 .3 .6 RG .8 .9 1 rg B", 1))
        r = self.call("verify-signature", {}, bad)
        self.assertFalse(r["details"]["allSignaturesIntactAndCurrent"])
        self.assertEqual(r["details"]["signatures"][0]["status"], "INVALID")

    def test_wrong_certificate_password_no_output(self):
        with self.assertRaises(engine.PdfError) as e:
            self.call("certificate-sign", {"certificatePath": str(self.p12), "certificatePassword": "WRONG"})
        self.assertEqual(e.exception.code, "CERTIFICATE_PASSWORD_OR_FORMAT")

    def test_unsigned_is_not_signature_success(self):
        r = self.call("verify-signature")
        self.assertEqual(r["details"]["signatureCount"], 0)
        self.assertFalse(r["details"]["allSignaturesIntactAndCurrent"])

    def test_malformed_pdf_rejected(self):
        bad = self.root / "broken.pdf"
        bad.write_bytes(b"%PDF-1.7\nnot a valid document")
        with self.assertRaises(engine.PdfError) as e:
            self.call("verify-signature", source=bad)
        self.assertEqual(e.exception.code, "INVALID_PDF")

    def test_pdfa_converts_all_profiles_and_validates(self):
        for profile in ("1b", "2b", "3b"):
            with self.subTest(profile=profile):
                r = self.call("pdfa", {"profile": profile})
                self.assertTrue(r["details"]["conforms"])
                output = Path(r["outputs"][0]["path"])
                v = self.call("validate-pdfa", {"profile": profile}, output)
                self.assertTrue(v["details"]["conforms"])
                with fitz.open(self.source) as before, fitz.open(output) as after:
                    self.assertEqual(len(before), len(after))
                    self.assertIn("ARCHIVE TEST", after[0].get_text())
                    for i in range(len(before)):
                        a = before[i].get_pixmap(alpha=False)
                        b = after[i].get_pixmap(alpha=False)
                        self.assertEqual((a.width,a.height),(b.width,b.height))
                        # Allow font antialiasing changes but reject broad layout shifts.
                        import numpy as np
                        pa=np.frombuffer(a.samples,dtype=np.uint8).astype(np.int16)
                        pb=np.frombuffer(b.samples,dtype=np.uint8).astype(np.int16)
                        self.assertLess(float(np.mean(np.abs(pa-pb))), 3.0)
                        if profile == "2b":
                            qa = Path(__file__).resolve().parents[2] / "archive-ui-fixtures"
                            qa.mkdir(exist_ok=True)
                            a.save(qa / f"archive-before-page-{i+1}.png")
                            b.save(qa / f"archive-after-page-{i+1}.png")
                if profile == "2b":
                    shutil.copyfile(output, qa / "archive-pdfa-2b.pdf")
                    (qa / "archive-pdfa-2b-verification.json").write_text(json.dumps(r["details"],indent=2),encoding="utf-8")

    def test_plain_pdf_is_nonconformant(self):
        r = self.call("validate-pdfa", {"profile": "2b"})
        self.assertFalse(r["details"]["conforms"])
        self.assertGreater(r["details"]["failedRules"], 0)
        self.assertEqual(len(r["outputs"]), 2)
        self.assertTrue(all(Path(v["path"]).suffix in {".json", ".xml"} for v in r["outputs"]))

    def test_conversion_noncompliance_is_not_published(self):
        fake = {"conforms":False, "failures":[{"clause":"TEST", "description":"Forced failure"}]}
        with patch.object(archive, "_validate_pdfa", return_value=(fake,b"<report/>")):
            with self.assertRaises(engine.PdfError) as e:
                self.call("pdfa")
            self.assertEqual(e.exception.code, "PDFA_NONCOMPLIANT")

    def test_passwords_do_not_enter_subprocess_args(self):
        encrypted = self.root / "encrypted.pdf"
        with fitz.open(self.source) as doc:
            doc.save(encrypted, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner-secret-312", user_pw="pdf-secret-434")
        seen = []
        original_run = archive._run_process
        def capture(args, *a, **kw):
            seen.extend(map(str,args))
            return original_run(args,*a,**kw)
        with patch.object(archive,"_run_process",capture):
            r = self.call("pdfa",source=encrypted,password="pdf-secret-434")
        self.assertTrue(r["details"]["conforms"])
        self.assertNotIn("pdf-secret-434", " ".join(seen))
        with self.assertRaises(engine.PdfError) as e:
            self.call("validate-pdfa",source=encrypted,password="pdf-secret-434")
        self.assertEqual(e.exception.code,"PDFA_ENCRYPTED")

    def test_cancelled_job_is_stopped(self):
        job=engine.Job(str(self.root),"pdfa")
        job.cancelled=True
        try:
            with self.assertRaises(engine.PdfError) as e:
                archive.run_archive("pdfa",[self.source],{},job)
            self.assertEqual(e.exception.code,"CANCELLED")
        finally:
            job.cleanup_failed()

    def test_live_subprocess_cancellation_kills_child(self):
        job=engine.Job(str(self.root),"pdfa")
        counts=[0]
        def cancel_after_start():
            counts[0]+=1
            if counts[0]>2:
                raise engine.PdfError("CANCELLED","Synthetic cancellation")
        job.check_cancelled=cancel_after_start
        stopped=[]
        original_stop=engine.stop_process_tree
        def stop(process):
            original_stop(process)
            process.wait(timeout=10)
            stopped.append(process.poll())
        try:
            with patch.object(engine,"stop_process_tree",stop):
                with self.assertRaises(engine.PdfError) as e:
                    archive._run_process([sys.executable,"-c","import time; time.sleep(20)"],job)
            self.assertEqual(e.exception.code,"CANCELLED")
            self.assertEqual(len(stopped),1)
            self.assertIsNotNone(stopped[0])
        finally:
            job.cleanup_failed()

    def test_encrypted_pdf_sign_and_verify_preserves_encryption(self):
        import pikepdf
        encrypted=self.root/"sign-encrypted.pdf"
        # Use the same standards-compliant encrypted format as engine Protect.
        # MuPDF writes inline Encrypt dictionaries that strict pyHanko rejects.
        with pikepdf.open(self.source) as doc:
            doc.save(encrypted,encryption=pikepdf.Encryption(owner="demo-owner-729",user="demo-open-938",R=6))
        signed=self.call("certificate-sign",{"certificatePath":str(self.p12),"certificatePassword":self.passphrase},
                         encrypted,"demo-open-938")
        target=Path(signed["outputs"][0]["path"])
        with fitz.open(target) as doc:
            self.assertTrue(doc.needs_pass)
        verified=self.call("verify-signature",source=target,password="demo-open-938")
        self.assertTrue(verified["details"]["allSignaturesIntactAndCurrent"])

    def test_invalid_trust_certificate_rejected(self):
        path=self.root/"bad.pem";path.write_bytes(b"not a certificate")
        with self.assertRaises(engine.PdfError) as e:
            self.call("verify-signature",{"trustCertificatePaths":[str(path)]},self.signed_path)
        self.assertEqual(e.exception.code,"INVALID_CERTIFICATE")


if __name__ == "__main__":
    if "--export-fixtures" in sys.argv:
        ArchiveTests.setUpClass()
        try:
            dest=Path(__file__).resolve().parents[2]/"archive-ui-fixtures"
            dest.mkdir(exist_ok=True)
            for source in (ArchiveTests.source,ArchiveTests.p12,ArchiveTests.trust,ArchiveTests.signed_path):
                shutil.copyfile(source,dest/source.name)
            (dest/'README.txt').write_text('SYNTHETIC TEST/DEMO FIXTURES ONLY. Self-signed certificate establishes no trusted identity.\nPKCS12 test password: '+ArchiveTests.passphrase+'\nDo not include this directory or its test private key in the app release.\n')
            print(dest)
        finally:
            ArchiveTests.tearDownClass()
    else:
        unittest.main(verbosity=2)
