"""Unified Studio's private, offline PDF worker. One JSON request on stdin.

Isolated adaptation of the reviewed Apple English PDFToolbox workflows. No
password guessing, network calls, shell invocation, input edits or overwrites.
"""
from __future__ import annotations

import base64
from collections import Counter
from contextlib import ExitStack, redirect_stdout, redirect_stderr
from datetime import datetime
import difflib
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from document_paths import document_path

import pymupdf as fitz
import pikepdf
from PIL import Image, ImageOps

fitz.TOOLS.mupdf_display_errors(False)
fitz.TOOLS.mupdf_display_warnings(False)
HERE = Path(__file__).resolve().parent
ACTIONS = {"inspect", "preview", "unlock", "protect", "merge", "split", "extract",
           "reorder", "rotate", "compress", "images-to-pdf", "pdf-to-images",
           "watermark", "page-numbers", "redact", "fill-form", "sign",
           "extract-text", "ocr", "office-to-pdf", "capabilities"}
ACTIONS.update({"remove-pages", "repair", "crop", "add-text", "extract-images", "compare",
                "summarize", "extract-layout", "pdf-to-word", "pdf-to-pptx", "pdf-to-excel",
                "recover-password", "scan-to-pdf", "html-to-pdf", "annotate", "pdfa", "translate", "ai-extract"})
ALIASES = {"extract-structured": "extract-layout", "pdf-to-docx": "pdf-to-word", "pdf-to-xlsx": "pdf-to-excel"}
ACTIONS.update(ALIASES)
ARCHIVE_ACTIONS = {"pdfa", "validate-pdfa", "certificate-sign", "verify-signature"}
ACTIONS.update(ARCHIVE_ACTIONS)
MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_PDF_BYTES = 2 * 1024 * 1024 * 1024
MAX_PAGES = 2000
MAX_IMAGE_PIXELS = 60_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class PdfError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def require(condition, message, code="INVALID_OPTIONS"):
    if not condition:
        raise PdfError(code, message)


def number(value, default, low, high, name, integer=False):
    value = default if value is None else value
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value), f"{name} must be a number.")
    require(low <= value <= high, f"{name} must be between {low} and {high}.")
    require(not integer or value == int(value), f"{name} must be a whole number.")
    return int(value) if integer else float(value)


def checked_path(value, extensions=None, directory=False):
    try:
        path = Path(document_path(value)).resolve(strict=True)
        path = Path(document_path(str(path)))
    except ValueError as error:
        raise PdfError("INVALID_OPTIONS", str(error)) from error
    require(path.is_dir() if directory else path.is_file(), "The selected path is not a regular file or folder.")
    if not directory:
        limit = MAX_PDF_BYTES if path.suffix.lower() == '.pdf' else MAX_INPUT_BYTES
        require(0 < path.stat().st_size <= limit, "Files must be nonempty; PDFs can be at most 2 GB and other inputs at most 512 MB.")
    if extensions:
        require(path.suffix.lower() in extensions, "The selected file type is not supported for this action.")
    return path


def page_indices(spec, total, duplicates=False, required=False):
    if spec is None or spec == "":
        require(not required, "Enter the pages to use, such as 1-3,5.")
        return list(range(total))
    require(isinstance(spec, str) and len(spec) <= 16000, "Enter page numbers as a range such as 1-3,5.")
    out = []
    for chunk in spec.replace(" ", "").split(","):
        match = re.fullmatch(r"([1-9]\d*)(?:-([1-9]\d*))?", chunk)
        require(match is not None, "Page ranges must look like 1-3,5; blank or invalid entries are not allowed.")
        start, end = int(match[1]), int(match[2] or match[1])
        require(1 <= start <= total and 1 <= end <= total, f"Page numbers must be between 1 and {total}.")
        step = 1 if end >= start else -1
        out.extend(range(start - 1, end - 1 + step, step))
        require(len(out) <= 5000, "A page selection may contain at most 5000 entries.")
    return out if duplicates else list(dict.fromkeys(out))


def open_pdf(path, password="", allow_locked=False):
    require(isinstance(password, str) and len(password) <= 1024, "The password must be text.")
    try:
        doc = fitz.open(str(path))
    except Exception:
        raise PdfError("INVALID_PDF", "The PDF could not be opened. It may be damaged or an unsupported format.")
    if doc.needs_pass and not doc.authenticate(password):
        if allow_locked:
            return doc
        doc.close()
        raise PdfError("PASSWORD_REQUIRED", "Enter the correct PDF opening password. Unknown passwords are not recovered or guessed.")
    require(doc.is_pdf, "Select a PDF document.", "INVALID_PDF")
    require(0 < doc.page_count <= MAX_PAGES, f"PDFs must contain between 1 and {MAX_PAGES} pages.")
    return doc


def color(value):
    require(isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value), "Choose a six-digit color such as #777777.")
    return tuple(int(value[i:i + 2], 16) / 255 for i in (1, 3, 5))


def display_box(page, value):
    require(isinstance(value, dict), "Select a rectangular area on the page.")
    vals = [number(value.get(key), None, -1e6, 1e6, key) for key in ("x0", "y0", "x1", "y1")]
    rect = fitz.Rect(vals)
    require(not rect.is_empty and rect.width >= 1 and rect.height >= 1, "The selected area must have positive width and height.")
    require(rect.x0 >= 0 and rect.y0 >= 0 and rect.x1 <= page.rect.width + 0.01 and rect.y1 <= page.rect.height + 0.01,
            "The selected area must be inside the displayed page.")
    return rect * page.derotation_matrix


def field_list(doc):
    out = []
    for page in doc:
        for widget in page.widgets() or []:
            out.append({"name": widget.field_name, "type": widget.field_type_string,
                        "value": widget.field_value, "page": page.number + 1,
                        "rect": list(widget.rect * page.rotation_matrix),
                        "choices": widget.choice_values,
                        "readOnly": bool(widget.field_flags & 1)})
    return out


def find_office():
    candidates = [HERE / 'runtime/libreoffice/LibreOffice.app/Contents/MacOS/soffice', Path('/Applications/LibreOffice.app/Contents/MacOS/soffice'), HERE / "runtime" / "libreoffice" / "program" / "soffice.com",
                  HERE / "runtime" / "libreoffice" / "program" / "soffice.exe",
                  HERE / "optional" / "LibreOffice" / "program" / "soffice.exe"]
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base:
            candidates.append(Path(base) / "LibreOffice" / "program" / "soffice.exe")
    found = shutil.which("soffice")
    if found:
        candidates.append(Path(found))
    return next((p.resolve() for p in candidates if p.is_file()), None)


def stop_process_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        killer = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
        try:
            subprocess.run([str(killer), "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                           timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (subprocess.TimeoutExpired, OSError):
            # Do not replace the user's cancellation with a taskkill error.
            # The owned process handle remains valid even if Windows' helper stalls.
            pass
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
    else:
        process.kill()


def extra_capabilities():
    archive, language = {}, {}
    if (HERE / "advanced_archive.py").is_file():
        from advanced_archive import archive_capabilities
        archive = archive_capabilities()
    if (HERE / "advanced_language.py").is_file():
        from advanced_language import capabilities as language_capabilities
        language = language_capabilities()
    return archive, language


def capabilities():
    ocr_models = HERE / "runtime" / "site-packages" / "rapidocr_onnxruntime" / "models"
    ocr = len(list(ocr_models.glob("*.onnx"))) >= 3
    office = find_office()
    archive, language = extra_capabilities()
    any_ocr = ocr or bool(language.get("ocr", {}).get("available"))
    extra = {**archive.get("actions", {}),
             "translate": bool(language.get("translation", {}).get("available")),
             "ai-extract": bool(language.get("docling", {}).get("available"))}
    missing_notes = {"pdfa": "The archival converter or veraPDF validator is missing.",
                     "validate-pdfa": "The veraPDF validator is missing.",
                     "certificate-sign": "The certificate signing runtime is missing.",
                     "verify-signature": "The certificate validation runtime is missing.",
                     "translate": "The bundled English/Korean translation runtime or models are missing.",
                     "ai-extract": "The bundled Docling runtime or models are missing."}
    unavailable = {action: note for action, note in missing_notes.items() if not extra.get(action)}
    operations = json.loads((HERE / "operations.json").read_text(encoding="utf-8"))
    for operation in operations:
        action = ALIASES.get(operation["id"], operation["id"])
        operation["available"] = action not in unavailable and (any_ocr if operation.get("requires") == "ocr" else office is not None if operation.get("requires") == "office" else True)
        if action in unavailable:
            operation["reason"] = unavailable[action]
    available_actions = ACTIONS - {"capabilities"} - set(unavailable)
    if not any_ocr:
        available_actions.discard("ocr")
    if office is None:
        available_actions.discard("office-to-pdf")
    return {"engine": "Unified Studio local PDF", "python": sys.version.split()[0],
            "pymupdf": fitz.VersionBind, "pikepdf": pikepdf.__version__,
            "offline": True, "portable": str(sys.executable).startswith(str(HERE)),
            "actions": sorted(available_actions),
            "operations": operations,
            "ocr": {"available": ocr or bool(language.get("ocr", {}).get("available")), "engine": "RapidOCR / ONNX and Tesseract",
                    "languages": ["English", "Chinese"] + (["Korean"] if language.get("ocr", {}).get("available") else []),
                    "note": "Bundled recognition models run offline."},
            "archive": archive, "language": language,
            "office": {"available": office is not None, "engine": "LibreOffice", "path": str(office) if office else None,
                       "note": "A separate local LibreOffice installation is required when no portable optional runtime is bundled."},
            "limits": {"inputMB": 512, "pdfInputMB": 2048, "pages": MAX_PAGES, "pageSelectionEntries": 5000,
                       "digitalCertificateSigning": bool(extra.get("certificate-sign")), "unknownPasswordRecovery": False},
            "unavailable": unavailable}


def run_language(action, options):
    runtime = HERE / "runtime" / "language" / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    require(runtime.is_file(), "The bundled language runtime is missing.", "CAPABILITY_UNAVAILABLE")
    parent = checked_path(options.get("outputDir"), directory=True)
    process = subprocess.Popen([str(runtime), "-I", "-B", str(HERE / "advanced_language.py")],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               shell=False, cwd=HERE,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        raw, _ = process.communicate(json.dumps({"action": action, "options": options}).encode("utf-8"), timeout=14 * 60)
        require(len(raw) <= 24 * 1024 * 1024, "The language result exceeded its response limit.", "OUTPUT_TOO_LARGE")
        result = json.loads(raw.decode("utf-8"))
        require(isinstance(result, dict) and isinstance(result.get("ok"), bool) and isinstance(result.get("outputs"), list),
                "The language engine did not return a valid result.", "RUNTIME_FAILED")
        if not result["ok"]:
            error = result.get("error", {})
            raise PdfError(error.get("code", "PROCESSING_FAILED"), error.get("message", "The language operation failed."))
        require(process.returncode == 0 and result["outputs"], "The language operation did not produce an output.", "OUTPUT_FAILED")
        for item in result["outputs"]:
            output = checked_path(item.get("path"))
            require(output.is_relative_to(parent) and output.parent != parent and output.parent.name.startswith("Unified-PDF-"),
                    "The language engine returned an invalid output location.", "OUTPUT_FAILED")
        return result
    except subprocess.TimeoutExpired:
        raise PdfError("TIMEOUT", "The language operation exceeded its time limit. The original was not changed; a partial result folder may remain.")
    finally:
        if process.poll() is None:
            stop_process_tree(process)
            process.communicate(timeout=10)


class Job:
    def __init__(self, parent, action):
        self.parent = checked_path(parent, directory=True)
        self.path = Path(tempfile.mkdtemp(prefix=f"Unified-PDF-{action}-{datetime.now():%Y%m%d-%H%M%S}-", dir=self.parent)).resolve()
        self.outputs = []

    def target(self, name):
        require(Path(name).name == name and name not in {".", ".."}, "Invalid output filename.")
        path = self.path / name
        require(not path.exists(), "The output already exists.", "OUTPUT_EXISTS")
        return path

    def add(self, path):
        require(path.is_file() and path.stat().st_size > 0, "The operation did not produce a valid output.", "OUTPUT_FAILED")
        self.outputs.append({"path": str(path), "name": path.name, "bytes": path.stat().st_size})

    def pdf(self, doc, name, **kwargs):
        path = self.target(name)
        doc.save(str(path), garbage=4, deflate=True, encryption=fitz.PDF_ENCRYPT_NONE, **kwargs)
        self.add(path)
        return path

    def cleanup_failed(self):
        # Only the fresh directory created by this instance may be removed.
        resolved = self.path.resolve()
        if resolved.parent == self.parent and resolved.name.startswith("Unified-PDF-"):
            shutil.rmtree(resolved, ignore_errors=True)


def run(action, options):
    require(action in ACTIONS, "This PDF action is not supported.", "UNKNOWN_ACTION")
    action = ALIASES.get(action, action)
    require(isinstance(options, dict), "Options must be an object.")
    if action == "capabilities":
        return {"ok": True, "outputs": [], "details": capabilities(), "warnings": []}
    if action in capabilities()["unavailable"]:
        raise PdfError("CAPABILITY_UNAVAILABLE", capabilities()["unavailable"][action])
    inputs = options.get("inputs")
    require(isinstance(inputs, list) and 1 <= len(inputs) <= 200, "Select between 1 and 200 input files.")
    image_ext = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}
    office_ext = {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf"}
    exts = image_ext if action in {"images-to-pdf", "scan-to-pdf"} else office_ext if action == "office-to-pdf" else {".html", ".htm"} if action == "html-to-pdf" else {".pdf"}
    paths = [checked_path(value, exts) for value in inputs]
    if action not in {"merge", "images-to-pdf", "scan-to-pdf", "compare"}:
        require(len(paths) == 1, "Select exactly one input file for this action.")
    password = options.get("password", "")
    require(isinstance(password, str), "The password must be text.")
    if action == "ocr":
        require(options.get("language", "rapid") in {"rapid", "eng", "kor", "eng+kor"}, "Choose an available OCR language.")
    if action in {"translate", "ai-extract"} or (action == "ocr" and options.get("language") in {"eng", "kor", "eng+kor"}):
        return run_language(action, {**options, "inputs": [str(p) for p in paths]})
    warnings, details = [], {}
    job = None
    try:
        if action in ARCHIVE_ACTIONS:
            from advanced_archive import run_archive
            job = Job(options.get("outputDir"), action)
            reply = run_archive(action, paths, options, job, password)
            require(job.outputs, "The archive tool did not produce an output.", "OUTPUT_FAILED")
            return {"ok": True, "outputs": job.outputs, "details": reply.get("details", {}), "warnings": reply.get("warnings", [])}
        with ExitStack() as stack:
            if action not in {"images-to-pdf", "scan-to-pdf", "office-to-pdf", "html-to-pdf"}:
                first_password = password
                if action == "merge" and isinstance(options.get("passwords"), list) and options["passwords"]:
                    first_password = options["passwords"][0]
                doc = stack.enter_context(open_pdf(paths[0], first_password, action in {"inspect", "recover-password"}))
                if action == "inspect":
                    locked = bool(doc.is_encrypted)
                    details = {"pageCount": doc.page_count, "encrypted": bool(doc.metadata and doc.metadata.get("encryption")) or locked,
                               "needsPassword": locked, "pages": [], "fields": [], "metadata": {}}
                    if not locked:
                        details.update({"pages": [{"page": p.number + 1, "width": p.rect.width, "height": p.rect.height,
                                                    "rotation": p.rotation} for p in doc],
                                        "fields": field_list(doc), "metadata": doc.metadata})
                    return {"ok": True, "outputs": [], "details": details, "warnings": []}
                if action == "preview":
                    pn = number(options.get("page"), 1, 1, doc.page_count, "Page", True)
                    width = number(options.get("maxWidth"), 1100, 200, 2000, "Preview width", True)
                    page = doc[pn - 1]
                    scale = min(width / page.rect.width, 2000 / page.rect.height)
                    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                    return {"ok": True, "outputs": [], "details": {"page": pn, "pageCount": doc.page_count,
                            "width": page.rect.width, "height": page.rect.height, "pngBase64": base64.b64encode(pix.tobytes("png")).decode("ascii")}, "warnings": []}
                if doc.metadata and doc.metadata.get("encryption") and action not in {"unlock", "protect"}:
                    warnings.append("The edited copy is unencrypted. Use Protect to apply a new opening password.")
            job = Job(options.get("outputDir"), action)

            if action in {"unlock", "protect"}:
                try:
                    source = stack.enter_context(pikepdf.open(paths[0], password=password))
                except pikepdf.PasswordError:
                    raise PdfError("PASSWORD_REQUIRED", "Enter the correct PDF opening password.")
                target = job.target(f"{action}.pdf")
                if action == "protect":
                    new = options.get("newPassword")
                    owner = options.get("ownerPassword") or secrets.token_urlsafe(32)
                    require(isinstance(new, str) and 0 < len(new.encode("utf-8")) <= 127, "Enter a new password of 1 to 127 UTF-8 bytes.")
                    require(isinstance(owner, str) and 0 < len(owner.encode("utf-8")) <= 127, "The owner password may contain at most 127 UTF-8 bytes.")
                    allowed = options.get("permissions", {})
                    require(isinstance(allowed, dict) and all(isinstance(v, bool) for v in allowed.values()), "Permissions must be true or false.")
                    perm = pikepdf.Permissions(accessibility=True, extract=allowed.get("copy", True),
                        modify_annotation=allowed.get("annotate", True), modify_assembly=allowed.get("modify", False),
                        modify_form=allowed.get("forms", True), modify_other=allowed.get("modify", False),
                        print_lowres=allowed.get("print", True), print_highres=allowed.get("print", True))
                    source.save(target, encryption=pikepdf.Encryption(owner=owner, user=new, R=6, allow=perm))
                    details["encryption"] = "AES-256"
                    warnings.append("PDF permission restrictions depend on the reader; the opening password provides encryption.")
                else:
                    source.save(target, encryption=False)
                job.add(target)

            elif action == "merge":
                require(len(paths) >= 2, "Select at least two PDFs to merge.")
                passwords = options.get("passwords", [])
                require(isinstance(passwords, list) and all(isinstance(p, str) for p in passwords), "Input passwords must be a list of strings.")
                merged = stack.enter_context(fitz.open())
                for index, path in enumerate(paths):
                    source = stack.enter_context(open_pdf(path, passwords[index] if index < len(passwords) else password))
                    require(merged.page_count + source.page_count <= MAX_PAGES, f"The merged file may contain at most {MAX_PAGES} pages.")
                    merged.insert_pdf(source, widgets=True, join_duplicates=False)
                job.pdf(merged, "merged.pdf")
                details["pageCount"] = merged.page_count

            elif action == "split":
                groups = options.get("groups")
                if groups is not None:
                    require(isinstance(groups, list) and 1 <= len(groups) <= MAX_PAGES, "Provide at least one split range.")
                    groups = [page_indices(group, doc.page_count, required=True) for group in groups]
                else:
                    every = number(options.get("every"), 1, 1, doc.page_count, "Pages per part", True)
                    groups = [list(range(start, min(start + every, doc.page_count))) for start in range(0, doc.page_count, every)]
                for index, pages in enumerate(groups):
                    with fitz.open() as part:
                        for page in pages:
                            part.insert_pdf(doc, from_page=page, to_page=page, widgets=True)
                        job.pdf(part, f"part-{index + 1:04}.pdf")
                details["parts"] = len(groups)

            elif action in {"extract", "reorder", "remove-pages"}:
                selected = page_indices(options.get("pages"), doc.page_count, action == "reorder", required=True)
                if action == "remove-pages":
                    selected = [index for index in range(doc.page_count) if index not in set(selected)]
                    require(selected, "Keep at least one page in the document.")
                doc.select(selected)
                job.pdf(doc, f"{action}.pdf")
                details["pageCount"] = doc.page_count

            elif action == "rotate":
                angle = options.get("angle", 90)
                require(angle in {90, 180, 270, -90}, "Rotation must be 90, 180, 270 or -90 degrees.")
                for index in page_indices(options.get("pages"), doc.page_count):
                    doc[index].set_rotation((doc[index].rotation + angle) % 360)
                job.pdf(doc, "rotated.pdf")

            elif action in {"compress", "repair"}:
                job.pdf(doc, "repaired.pdf" if action == "repair" else "compressed.pdf", use_objstms=1)
                original, result = paths[0].stat().st_size, job.outputs[0]["bytes"]
                details.update({"inputBytes": original, "outputBytes": result, "savedBytes": original - result, "lossless": True})
                if result >= original:
                    warnings.append("This document was already compact; lossless optimization did not reduce its size.")

            elif action in {"images-to-pdf", "scan-to-pdf"}:
                out = stack.enter_context(fitz.open())
                size = options.get("pageSize", "image")
                require(size in {"image", "A4"}, "Page size must be image or A4.")
                margin = number(options.get("margin"), 24, 0, 140, "Margin")
                for path in paths:
                    with Image.open(path) as raw:
                        require(raw.width * raw.height <= MAX_IMAGE_PIXELS, "Images may contain at most 60 million pixels.")
                        for frame in range(getattr(raw, "n_frames", 1)):
                            require(out.page_count < MAX_PAGES, f"Output may contain at most {MAX_PAGES} pages.")
                            raw.seek(frame)
                            picture = ImageOps.exif_transpose(raw).convert("RGB")
                            if action == "scan-to-pdf":
                                picture = ImageOps.autocontrast(picture, cutoff=1)
                                if options.get("grayscale", False):
                                    picture = ImageOps.grayscale(picture).convert("RGB")
                            buffer = io.BytesIO()
                            picture.save(buffer, format="PNG")
                            width, height = (595.276, 841.89) if size == "A4" else (picture.width * 0.75, picture.height * 0.75)
                            page = out.new_page(width=width, height=height)
                            area = page.rect + (margin, margin, -margin, -margin) if size == "A4" else page.rect
                            page.insert_image(area, stream=buffer.getvalue(), keep_proportion=True)
                job.pdf(out, "images.pdf")
                details["pageCount"] = out.page_count

            elif action == "pdf-to-images":
                dpi = number(options.get("dpi"), 144, 72, 300, "Resolution", True)
                fmt = options.get("format", "png")
                require(fmt in {"png", "jpg"}, "Image format must be png or jpg.")
                for index in page_indices(options.get("pages"), doc.page_count):
                    page = doc[index]
                    require(page.rect.width * page.rect.height * (dpi / 72) ** 2 <= MAX_IMAGE_PIXELS, "This page is too large at that resolution. Choose a lower resolution.")
                    pix = page.get_pixmap(dpi=dpi, alpha=False)
                    target = job.target(f"page-{index + 1:04}.{fmt}")
                    pix.save(str(target))
                    job.add(target)

            elif action in {"watermark", "page-numbers"}:
                font_size = number(options.get("fontSize"), 36 if action == "watermark" else 10, 6, 144, "Font size")
                rgb = color(options.get("color", "#777777" if action == "watermark" else "#333333"))
                opacity = number(options.get("opacity"), .25 if action == "watermark" else 1, .05, 1, "Opacity")
                text = options.get("text", "") if action == "watermark" else options.get("template", "{page} / {total}")
                require(isinstance(text, str) and 0 < len(text) <= 1000, "Enter between 1 and 1000 characters.")
                position = options.get("position", "bottom-center")
                require(position in {"bottom-center", "bottom-left", "bottom-right", "top-center"}, "Choose a supported page-number position.")
                start = number(options.get("start"), 1, 0, 100000, "Starting number", True)
                for count, index in enumerate(page_indices(options.get("pages"), doc.page_count)):
                    page = doc[index]
                    content = text if action == "watermark" else text.replace("{page}", str(start + count)).replace("{total}", str(doc.page_count))
                    fontname = "korea" if any(ord(c) > 255 for c in content) else "helv"
                    w, h = page.rect.width, page.rect.height
                    margin = min(24, w / 8, h / 8)
                    y = h / 2 - font_size if action == "watermark" else margin if position.startswith("top") else h - margin - font_size * 1.6
                    box = fitz.Rect(margin, y, w - margin, y + font_size * 2.3) * page.derotation_matrix
                    alignment = 0 if position.endswith("left") else 2 if position.endswith("right") else 1
                    remain = page.insert_textbox(box, content, fontsize=font_size, fontname=fontname, color=rgb,
                                                align=alignment if action == "page-numbers" else 1, overlay=True,
                                                fill_opacity=opacity, rotate=page.rotation)
                    require(remain >= 0, "The text does not fit. Shorten it or reduce the font size.")
                job.pdf(doc, f"{action}.pdf")

            elif action == "redact":
                require(options.get("confirmed") is True, "Confirm that the marked content should be permanently removed from the new copy.", "CONFIRM_REDACTION")
                boxes = options.get("boxes", [])
                terms = options.get("terms", [])
                search = options.get("searchText", "")
                require(isinstance(boxes, list) and len(boxes) <= 10000, "Redaction boxes must be a list with at most 10000 areas.")
                require(isinstance(terms, list) and len(terms) <= 100 and all(isinstance(term, str) and 0 < len(term) <= 1000 for term in terms), "Redaction search terms must be nonempty strings.")
                require(isinstance(search, str) and len(search) <= 1000, "Search text must contain at most 1000 characters.")
                terms = terms + ([search] if search.strip() else [])
                require(boxes or terms, "Mark an area or enter text to redact.")
                redactions = 0
                for box in boxes:
                    require(isinstance(box, dict), "Each redaction area must be an object.")
                    pn = number(box.get("page"), None, 1, doc.page_count, "Redaction page", True)
                    page = doc[pn - 1]
                    page.add_redact_annot(display_box(page, box), fill=(0, 0, 0), cross_out=False)
                    redactions += 1
                for index in page_indices(options.get("pages"), doc.page_count):
                    page = doc[index]
                    for term in terms:
                        for rect in page.search_for(term):
                            page.add_redact_annot(rect, fill=(0, 0, 0), cross_out=False)
                            redactions += 1
                require(redactions > 0, "No matching text was found. For scanned pages, mark a rectangular area.", "NO_MATCHES")
                # Apply actual PDF redaction, including intersecting image pixels and vector art.
                for page in doc:
                    page.apply_redactions(images=2, graphics=2, text=0)
                doc.scrub(attached_files=True, clean_pages=True, embedded_files=True, hidden_text=True,
                          javascript=True, metadata=True, redactions=True, remove_links=True, reset_fields=True,
                          reset_responses=True, thumbnails=True, xml_metadata=True)
                rasterize = options.get("rasterize", True)
                require(isinstance(rasterize, bool), "Rasterize must be true or false.")
                if rasterize:
                    dpi = number(options.get("dpi"), 150, 72, 300, "Resolution", True)
                    clean = stack.enter_context(fitz.open())
                    for page in doc:
                        require(page.rect.width * page.rect.height * (dpi / 72) ** 2 <= MAX_IMAGE_PIXELS, "A page is too large for secure flattening. Choose a lower resolution.")
                        pix = page.get_pixmap(dpi=dpi, alpha=False, annots=False)
                        outpage = clean.new_page(width=page.rect.width, height=page.rect.height)
                        outpage.insert_image(outpage.rect, pixmap=pix)
                    job.pdf(clean, "redacted.pdf")
                    warnings.append("Secure redaction creates flattened image pages. Text search, forms, links, layers and digital signatures are removed from the copy.")
                else:
                    job.pdf(doc, "redacted.pdf")
                    warnings.append("Vector redaction removes marked content and scrubs hidden text, metadata, attachments, scripts and form values. Review the output before sharing.")
                details.update({"redactionsApplied": redactions, "permanent": True, "flattened": rasterize})

            elif action == "fill-form":
                values = options.get("values")
                require(isinstance(values, dict) and 0 < len(values) <= 1000, "Provide a value for at least one form field.")
                require(all(isinstance(k, str) and isinstance(v, (str, bool, int, float)) and len(str(v)) <= 16000 for k, v in values.items()), "Form values must be text, numbers or booleans.")
                available = {field["name"] for field in field_list(doc)}
                require(set(values).issubset(available), "One or more field names do not exist. Inspect the form again.", "UNKNOWN_FIELD")
                count = 0
                for page in doc:
                    for widget in page.widgets() or []:
                        if widget.field_name not in values:
                            continue
                        require(widget.field_type != fitz.PDF_WIDGET_TYPE_SIGNATURE, "Certificate signature fields cannot be filled as ordinary text.")
                        require(not widget.field_flags & 1, "A selected field is read-only.")
                        value = values[widget.field_name]
                        if widget.field_type == fitz.PDF_WIDGET_TYPE_CHECKBOX:
                            require(isinstance(value, bool), "Checkbox values must be true or false.")
                            value = widget.on_state() if value else "Off"
                        widget.field_value = value if isinstance(value, str) else str(value)
                        widget.update()
                        count += 1
                if options.get("flatten", False):
                    doc.bake(annots=False, widgets=True)
                job.pdf(doc, "filled.pdf")
                details["fieldsUpdated"] = count

            elif action == "sign":
                signature = checked_path(options.get("signaturePath"), image_ext)
                pn = number(options.get("page"), 1, 1, doc.page_count, "Page", True)
                page = doc[pn - 1]
                area = display_box(page, options.get("box"))
                with Image.open(signature) as raw:
                    require(raw.width * raw.height <= MAX_IMAGE_PIXELS, "The signature image is too large.")
                    picture = ImageOps.exif_transpose(raw).convert("RGBA")
                    buffer = io.BytesIO()
                    picture.save(buffer, format="PNG")
                page.insert_image(area, stream=buffer.getvalue(), overlay=True, keep_proportion=True, rotate=page.rotation)
                job.pdf(doc, "signed.pdf")
                warnings.append("This is a visible signature image. It does not create a cryptographic or certificate signature.")

            elif action == "extract-text":
                target = job.target("extracted.txt")
                content = "\n\n".join(f"--- Page {index + 1} ---\n{doc[index].get_text(sort=True)}" for index in page_indices(options.get("pages"), doc.page_count))
                target.write_text(content, encoding="utf-8")
                job.add(target)
                details["characters"] = len(content)

            elif action == "ocr":
                require(capabilities()["ocr"]["available"], "The bundled offline OCR models are missing.", "CAPABILITY_UNAVAILABLE")
                from rapidocr_onnxruntime import RapidOCR
                import numpy as np
                dpi = number(options.get("dpi"), 150, 72, 300, "Resolution", True)
                ocr = RapidOCR()
                count = 0
                for index in page_indices(options.get("pages"), doc.page_count):
                    page = doc[index]
                    require(page.rect.width * page.rect.height * (dpi / 72) ** 2 <= MAX_IMAGE_PIXELS, "This page is too large for OCR at that resolution.")
                    if page.get_text().strip():
                        warnings.append(f"Page {index + 1} already contains text and was left unchanged.")
                        continue
                    pix = page.get_pixmap(dpi=dpi, alpha=False)
                    # RapidOCR uses OpenCV's BGR convention.
                    picture = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
                    result, _ = ocr(picture[:, :, ::-1].copy())
                    for bounds, content, confidence in result or []:
                        if not content or float(confidence) < .35:
                            continue
                        xs, ys = [p[0] for p in bounds], [p[1] for p in bounds]
                        rect = fitz.Rect(min(xs) * page.rect.width / pix.width, min(ys) * page.rect.height / pix.height,
                                         max(xs) * page.rect.width / pix.width, max(ys) * page.rect.height / pix.height)
                        # Map recognition coordinates back through any stored page rotation.
                        raw_rect = rect * page.derotation_matrix
                        font = "china-s" if any(ord(c) > 255 for c in content) else "helv"
                        pointsize = max(3, min(36, rect.height * .65))
                        remain = page.insert_textbox(raw_rect, content, fontname=font, fontsize=pointsize,
                                                    render_mode=3, rotate=page.rotation, overlay=True)
                        if remain < 0:
                            page.insert_text(fitz.Point(raw_rect.x0, raw_rect.y1 - 1), content,
                                             fontname=font, fontsize=max(2, pointsize * .5), render_mode=3, rotate=page.rotation)
                        count += 1
                job.pdf(doc, "searchable.pdf")
                details.update({"recognizedLines": count, "languages": ["English", "Chinese"]})
                warnings.append("Offline OCR may misread text. Review recognition before relying on extracted content. Korean is not supported by this model bundle.")

            elif action == "office-to-pdf":
                office = find_office()
                require(office is not None, "LibreOffice is not available. Install it locally or add the optional portable LibreOffice runtime to enable Office conversion.", "CAPABILITY_UNAVAILABLE")
                # LibreOffice creates deeply nested profile paths. Keep its
                # temporary staging path short even when the requested output
                # folder has a long Unicode path; preserve the original input.
                staging = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="us-pdf-office-")))
                profile = staging / "profile"
                conversion = staging / "out"
                conversion.mkdir()
                staged_source = staging / ("input" + paths[0].suffix.lower())
                shutil.copy2(paths[0], staged_source)
                (profile / "user").mkdir(parents=True)
                settings = ('<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
                    '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
                    '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
                    '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>'
                    '<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>'
                    '<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>'
                    '<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>'
                    '</oor:items>')
                (profile / "user" / "registrymodifications.xcu").write_text(settings, encoding="utf-8")
                process = subprocess.Popen([str(office), f"-env:UserInstallation={profile.as_uri()}", "--headless", "--nologo",
                                          "--nodefault", "--norestore", "--nofirststartwizard", "--convert-to", "pdf", "--outdir", str(conversion), str(staged_source)],
                                         shell=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                try:
                    process.communicate(timeout=180)
                except subprocess.TimeoutExpired:
                    stop_process_tree(process)
                    raise PdfError("TIMEOUT", "LibreOffice conversion exceeded three minutes. The source document was not changed.")
                result = conversion / "input.pdf"
                require(process.returncode == 0 and result.is_file(), "LibreOffice could not convert this file. Open it locally and check the document format.", "CONVERSION_FAILED")
                target = job.target("converted.pdf")
                shutil.copy2(result, target)
                job.add(target)
                warnings.append("Office conversion uses the local LibreOffice renderer; fonts and unsupported layout features can differ from Microsoft Office.")

            elif action == "recover-password":
                candidates = options.get("candidates", [])
                require(isinstance(candidates, list) and 1 <= len(candidates) <= 1000 and all(isinstance(v, str) and len(v) <= 127 for v in candidates),
                        "Provide 1 to 1000 candidate passwords you want to test. No built-in wordlists or unrestricted guessing are used.")
                seconds = number(options.get("maxSeconds"), 30, 1, 60, "Time limit", True)
                start_time = time.monotonic()
                found = False
                attempts = 0
                for index, candidate in enumerate(candidates):
                    if time.monotonic() - start_time >= seconds:
                        break
                    attempts += 1
                    try:
                        with pikepdf.open(paths[0], password=candidate) as unlocked:
                            target = job.target("unlocked.pdf")
                            unlocked.save(target, encryption=False)
                            job.add(target)
                            details.update({"matchedCandidate": index + 1, "attempts": attempts, "elapsedSeconds": round(time.monotonic() - start_time, 2)})
                            found = True
                            break
                    except pikepdf.PasswordError:
                        continue
                require(found, f"None of the {attempts} tested candidates opened this PDF within the time limit. Strong unknown passwords may not be recoverable.", "NO_PASSWORD_MATCH")
                warnings.append("Only your supplied candidates were tested locally. The matching password is not written to the output or logs.")

            elif action == "crop":
                for index in page_indices(options.get("pages"), doc.page_count):
                    page = doc[index]
                    area = display_box(page, options.get("box"))
                    # CropBox uses unrotated coordinates relative to the MediaBox.
                    area += (page.cropbox.x0, page.cropbox.y0, page.cropbox.x0, page.cropbox.y0)
                    page.set_cropbox(area)
                job.pdf(doc, "cropped.pdf")
                warnings.append("Cropping changes the visible page boundary. Use Redact to permanently remove confidential content.")

            elif action in {"add-text", "annotate"}:
                pn = number(options.get("page"), 1, 1, doc.page_count, "Page", True)
                page = doc[pn - 1]
                box = display_box(page, options.get("box"))
                text = options.get("text", "")
                require(isinstance(text, str) and 0 < len(text) <= 10000, "Enter between 1 and 10000 characters.")
                rgb = color(options.get("color", "#222222"))
                if action == "add-text":
                    size = number(options.get("fontSize"), 14, 6, 144, "Font size")
                    font = "korea" if any(ord(c) > 255 for c in text) else "helv"
                    remaining = page.insert_textbox(box, text, fontsize=size, fontname=font, color=rgb, rotate=page.rotation)
                    require(remaining >= 0, "Text does not fit the selected box. Enlarge it or reduce the font size.")
                else:
                    kind = options.get("kind", "note")
                    require(kind in {"note", "highlight", "rectangle"}, "Annotation kind must be note, highlight or rectangle.")
                    annotation = page.add_text_annot(box.tl, text) if kind == "note" else page.add_highlight_annot(box) if kind == "highlight" else page.add_rect_annot(box)
                    annotation.set_info(content=text)
                    annotation.set_colors(stroke=rgb)
                    annotation.update()
                job.pdf(doc, f"{action}.pdf")

            elif action == "extract-images":
                seen = set()
                for index in page_indices(options.get("pages"), doc.page_count):
                    for item in doc[index].get_images(full=True):
                        xref = item[0]
                        if not xref or xref in seen:
                            continue
                        seen.add(xref)
                        extracted = doc.extract_image(xref)
                        target = job.target(f"image-{len(seen):04}.{extracted['ext']}")
                        target.write_bytes(extracted["image"])
                        job.add(target)
                require(job.outputs, "No embedded raster images were found. Use PDF to Images to render complete pages.", "NO_IMAGES")
                warnings.append("Extracts embedded raster image resources. Vector drawings and page layout are not standalone images; transparency masks may be separate resources.")

            elif action == "compare":
                require(len(paths) == 2, "Choose exactly two PDF files to compare.")
                other = stack.enter_context(open_pdf(paths[1], options.get("secondPassword", password)))
                first_text = "\n".join(page.get_text(sort=True) for page in doc).splitlines()
                second_text = "\n".join(page.get_text(sort=True) for page in other).splitlines()
                comparison = "\n".join(difflib.unified_diff(first_text, second_text, fromfile=paths[0].name, tofile=paths[1].name, lineterm=""))
                target = job.target("text-comparison.diff.txt")
                target.write_text(comparison or "No text differences found.\n", encoding="utf-8")
                job.add(target)
                from PIL import ImageChops
                changed = []
                for index in range(max(doc.page_count, other.page_count)):
                    if index >= min(doc.page_count, other.page_count):
                        changed.append(index + 1)
                        continue
                    a, b = doc[index].get_pixmap(dpi=72, alpha=False), other[index].get_pixmap(dpi=72, alpha=False)
                    if (a.width, a.height) != (b.width, b.height) or a.samples != b.samples:
                        changed.append(index + 1)
                        if (a.width, a.height) == (b.width, b.height):
                            ia = Image.frombytes("RGB", (a.width, a.height), a.samples)
                            ib = Image.frombytes("RGB", (b.width, b.height), b.samples)
                            diff = ImageChops.difference(ia, ib)
                            output = job.target(f"page-{index + 1:04}-difference.png")
                            diff.save(output)
                            job.add(output)
                details.update({"textChanged": bool(comparison), "visuallyChangedPages": changed,
                                "firstPageCount": doc.page_count, "secondPageCount": other.page_count})
                warnings.append("Visual comparison is rendered at 72 DPI. It detects page appearance changes but is not a semantic or accessibility review.")

            elif action == "summarize":
                limit = number(options.get("sentences"), 7, 1, 50, "Summary sentences", True)
                text = "\n".join(doc[index].get_text(sort=True) for index in page_indices(options.get("pages"), doc.page_count))
                sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if len(s.strip()) >= 15]
                require(sentences, "There is not enough readable text. Run OCR on scanned pages first.", "NO_TEXT")
                stop = {"the", "and", "that", "with", "this", "from", "have", "for", "are", "was", "not", "you", "your", "but"}
                words = lambda s: [w.lower() for w in re.findall(r"\b\w{3,}\b", s) if w.lower() not in stop]
                freq = Counter(w for sentence in sentences for w in words(sentence))
                ranked = sorted(range(len(sentences)), key=lambda i: sum(freq[w] for w in words(sentences[i])) / max(1, len(words(sentences[i]))) ** .5, reverse=True)
                picked = sorted(ranked[:limit])
                target = job.target("summary.txt")
                target.write_text("LOCAL EXTRACTIVE SUMMARY\n\n" + "\n\n".join(sentences[i] for i in picked), encoding="utf-8")
                job.add(target)
                warnings.append("This offline summary selects existing sentences using word frequency. It is not generative AI and may omit important context.")

            elif action == "extract-layout":
                fmt = options.get("format", "json")
                require(fmt in {"json", "markdown"}, "Layout format must be json or markdown.")
                pages = page_indices(options.get("pages"), doc.page_count)
                if fmt == "json":
                    data = {"sourceName": paths[0].name, "pageCount": doc.page_count,
                            "pages": [{"page": index + 1, "width": doc[index].rect.width, "height": doc[index].rect.height,
                                       "blocks": [{"box": list(block[:4]), "text": block[4]} for block in doc[index].get_text("blocks") if block[6] == 0]}
                                      for index in pages]}
                    content = json.dumps(data, ensure_ascii=False, indent=2)
                else:
                    content = "\n\n".join(f"## Page {index + 1}\n\n{doc[index].get_text(sort=True).strip()}" for index in pages)
                target = job.target("layout.json" if fmt == "json" else "extracted.md")
                target.write_text(content, encoding="utf-8")
                job.add(target)
                warnings.append("This is local text/block extraction. Reading order and table semantics may need correction; no AI model is used.")

            elif action == "pdf-to-word":
                from pdf2docx import Converter
                selected = page_indices(options.get("pages"), doc.page_count)
                temporary = job.target("conversion-source.pdf")
                doc.save(str(temporary), encryption=fitz.PDF_ENCRYPT_NONE)
                target = job.target("converted.docx")
                converter = Converter(str(temporary))
                try:
                    converter.convert(str(target), pages=selected, multi_processing=False)
                finally:
                    converter.close()
                    temporary.unlink(missing_ok=True)
                job.add(target)
                warnings.append("PDF to Word reconstructs editable layout. Complex formatting, tables and reading order can differ; scanned pages need OCR first.")

            elif action == "pdf-to-pptx":
                from pptx import Presentation
                from pptx.util import Emu
                selected = page_indices(options.get("pages"), doc.page_count)
                dpi = number(options.get("dpi"), 144, 72, 300, "Resolution", True)
                presentation = Presentation()
                size = doc[selected[0]].rect
                presentation.slide_width, presentation.slide_height = Emu(int(size.width * 12700)), Emu(int(size.height * 12700))
                for index in selected:
                    page = doc[index]
                    require(page.rect.width * page.rect.height * (dpi / 72) ** 2 <= MAX_IMAGE_PIXELS, "This page is too large at that resolution.")
                    pix = page.get_pixmap(dpi=dpi, alpha=False)
                    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
                    ratio = min(size.width / page.rect.width, size.height / page.rect.height)
                    width, height = page.rect.width * ratio, page.rect.height * ratio
                    slide.shapes.add_picture(io.BytesIO(pix.tobytes("png")), Emu(int((size.width - width) / 2 * 12700)), Emu(int((size.height - height) / 2 * 12700)),
                                             width=Emu(int(width * 12700)), height=Emu(int(height * 12700)))
                target = job.target("page-images.pptx")
                presentation.save(target)
                job.add(target)
                warnings.append("Each PDF page becomes a slide image. Original text and objects are not independently editable. Mixed page sizes are letterboxed to the first page size.")

            elif action == "pdf-to-excel":
                from openpyxl import Workbook
                workbook = Workbook()
                workbook.remove(workbook.active)
                tables = 0
                for index in page_indices(options.get("pages"), doc.page_count):
                    page = doc[index]
                    found = page.find_tables().tables
                    for table_index, table in enumerate(found):
                        sheet = workbook.create_sheet(f"Page {index + 1} Table {table_index + 1}"[:31])
                        for row in table.extract():
                            sheet.append(["" if value is None else str(value) for value in row])
                        tables += 1
                    if not found:
                        sheet = workbook.create_sheet(f"Page {index + 1} Text")
                        for line in page.get_text(sort=True).splitlines():
                            # Treat source strings as literal text, never spreadsheet formulas.
                            sheet.append([line])
                    for sheet in workbook.worksheets:
                        for row in sheet.iter_rows():
                            for cell in row:
                                if cell.data_type == "f":
                                    cell.data_type = "s"
                target = job.target("extracted.xlsx")
                workbook.save(target)
                job.add(target)
                details["tablesExtracted"] = tables
                warnings.append("Detected tables are reconstructed in worksheets. Pages without detected tables are exported as text lines. Formula recovery is not supported.")

            elif action == "html-to-pdf":
                require(paths[0].stat().st_size <= 5 * 1024 * 1024, "Local HTML files may contain at most 5 MB.")
                html = paths[0].read_text(encoding="utf-8-sig")
                require(not re.search(r"(?is)<\s*(script|iframe|object|embed)|(?:https?:|file:|url\s*\(|<\s*img|<\s*link)", html),
                        "Use self-contained HTML text and CSS. Scripts, external resources, images and URLs are not loaded by this offline converter.")
                story = fitz.Story(html=html)
                target = job.target("html.pdf")
                writer = fitz.DocumentWriter(str(target))
                try:
                    page_count = 0
                    more = True
                    while more:
                        require(page_count < MAX_PAGES, "The HTML exceeds the page limit.")
                        device = writer.begin_page(fitz.Rect(0, 0, 595.276, 841.89))
                        more, _ = story.place(fitz.Rect(36, 36, 559.276, 805.89))
                        story.draw(device)
                        writer.end_page()
                        page_count += 1
                finally:
                    writer.close()
                job.add(target)
                details["pageCount"] = page_count
                warnings.append("Local static HTML/CSS rendering only. JavaScript, external assets and live website conversion are not supported.")

            require(job.outputs, "The selected operation produced no output.", "OUTPUT_FAILED")
            details["outputDirectory"] = str(job.path)
            return {"ok": True, "outputs": job.outputs, "details": details, "warnings": list(dict.fromkeys(warnings))}
    except Exception:
        if job:
            job.cleanup_failed()
        raise


def main():
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        require(len(raw) <= 2 * 1024 * 1024, "The request is too large.")
        request = json.loads(raw.decode("utf-8"))
        require(isinstance(request, dict), "Request must be an object.")
        # Third-party diagnostic output must not corrupt the JSON protocol or
        # disclose document contents/passwords through the application console.
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = run(request.get("action"), request.get("options", {}))
    except PdfError as error:
        result = {"ok": False, "outputs": [], "error": {"code": error.code, "message": error.message}}
    except (FileNotFoundError, PermissionError, OSError):
        result = {"ok": False, "outputs": [], "error": {"code": "FILE_ACCESS", "message": "The file or output folder is unavailable or not writable. Reconnect the drive or network share and check its permissions in File Explorer."}}
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        result = {"ok": False, "outputs": [], "error": {"code": "INVALID_OPTIONS", "message": "The supplied document or options are not valid for this operation."}}
    except Exception:
        result = {"ok": False, "outputs": [], "error": {"code": "PROCESSING_FAILED", "message": "The local PDF engine could not finish this operation. Check the selected document and options."}}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
