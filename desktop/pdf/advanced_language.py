"""Private offline English/Korean, OCR and Docling worker.

CLI: runtime/language/python/python.exe -I -B advanced_language.py
One {action, options} JSON request on stdin, one result on stdout. Passwords
stay on stdin. Importing this module and capabilities() never load AI models.
"""
from __future__ import annotations

from contextlib import contextmanager, redirect_stdout, redirect_stderr
from datetime import datetime
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import tempfile
import time
from document_paths import document_path

HERE = Path(__file__).resolve().parent
ROOT = HERE / "runtime" / "language"
PYTHON = ROOT / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
TESSDATA = ROOT / "tessdata"
FONT = ROOT / "fonts" / "NanumGothic-Regular.ttf"
MAX_BYTES = 512 * 1024 * 1024
MAX_PAGES = 200
MAX_PIXELS = 60_000_000
LANGUAGES = {"en": "English", "ko": "Korean"}


class LanguageError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def require(condition, message, code="INVALID_OPTIONS"):
    if not condition:
        raise LanguageError(code, message)


def capabilities():
    """Cheap file checks; no torch/CT2/Docling import and no network."""
    packages = ROOT / "python" / "site-packages"
    base = PYTHON.is_file()
    translation_files = [ROOT / "m2m100-int8" / name for name in ("model.bin", "sentencepiece.bpe.model", "config.json", "shared_vocabulary.json")]
    translation = base and FONT.is_file() and (packages / "ctranslate2").is_dir() and all(p.is_file() for p in translation_files)
    ocr = base and all((TESSDATA / f"{lang}.traineddata").is_file() for lang in ("eng", "kor"))
    layout = ROOT / "docling-models" / "docling-project--docling-layout-heron" / "model.safetensors"
    table = ROOT / "docling-models" / "docling-project--docling-models" / "model_artifacts" / "tableformer" / "accurate" / "tableformer_accurate.safetensors"
    docling = base and ocr and layout.is_file() and table.is_file() and (packages / "docling").is_dir()
    return {"available": bool(translation and ocr and docling), "offline": True,
            "translation": {"available": bool(translation), "engine": "M2M100-418M / CTranslate2 int8",
                            "pairs": [{"from": "en", "to": "ko"}, {"from": "ko", "to": "en"}],
                            "format": "Bilingual reflowed PDF, Markdown and JSON; original layout is not retained."},
            "ocr": {"available": bool(ocr), "engine": "Tesseract via PyMuPDF", "languages": ["eng", "kor", "eng+kor"]},
            "docling": {"available": bool(docling), "engine": "Docling", "version": "2.139.0",
                        "models": ["docling-layout-heron", "TableFormer accurate"]}}


def checked_path(value, directory=False):
    try:
        path = Path(document_path(value)).resolve(strict=True)
        path = Path(document_path(str(path)))
    except ValueError as error:
        raise LanguageError("INVALID_OPTIONS", str(error)) from error
    require(path.is_dir() if directory else path.is_file(), "The selected file or folder is unavailable.")
    if not directory:
        require(path.suffix.lower() == ".pdf", "Select a PDF document.")
        require(0 < path.stat().st_size <= MAX_BYTES, "PDFs must be nonempty and at most 512 MB.")
    return path


def pages(value, count):
    if value is None or value == "":
        result = list(range(count))
    else:
        require(isinstance(value, str) and len(value) < 16000, "Enter a page range such as 1-3,5.")
        result = []
        for item in value.replace(" ", "").split(","):
            m = re.fullmatch(r"([1-9]\d*)(?:-([1-9]\d*))?", item)
            require(m is not None, "Enter a page range such as 1-3,5.")
            start, end = int(m[1]), int(m[2] or m[1])
            require(1 <= start <= count and 1 <= end <= count, f"Page numbers must be between 1 and {count}.")
            require(abs(end - start) < MAX_PAGES, f"Process at most {MAX_PAGES} pages at a time.")
            result.extend(range(start - 1, end - 1 + (1 if end >= start else -1), 1 if end >= start else -1))
        result = list(dict.fromkeys(result))
    require(0 < len(result) <= MAX_PAGES, f"Process at most {MAX_PAGES} pages at a time.")
    return result


@contextmanager
def offline():
    """Fail closed on Python network attempts, including dependency downloads."""
    names = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
             "DO_NOT_TRACK": "1", "OMP_NUM_THREADS": "4", "TOKENIZERS_PARALLELISM": "false"}
    scratch = tempfile.TemporaryDirectory(prefix="us-language-cache-", ignore_cleanup_errors=True)
    names.update({"USERPROFILE": scratch.name, "HOME": scratch.name,
                  "HF_HOME": str(Path(scratch.name) / "huggingface"),
                  "TORCH_HOME": str(Path(scratch.name) / "torch"),
                  "DOCLING_CACHE_DIR": str(Path(scratch.name) / "docling")})
    previous = {name: os.environ.get(name) for name in names}
    os.environ.update(names)
    original_connect, original_ex, original_dns = socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo

    def denied(*args, **kwargs):
        raise LanguageError("OFFLINE_ONLY", "This worker cannot connect to the network. All models must be bundled locally.")

    socket.socket.connect = socket.socket.connect_ex = socket.getaddrinfo = denied
    try:
        yield
    finally:
        socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo = original_connect, original_ex, original_dns
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        scratch.cleanup()


def resolution(options):
    dpi = options.get("dpi", 250)
    require(isinstance(dpi, (float, int)) and not isinstance(dpi, bool) and math.isfinite(dpi)
            and dpi == int(dpi) and 72 <= dpi <= 300, "Resolution must be a whole number between 72 and 300 DPI.")
    return int(dpi)


def recognition_language(language):
    # In the bilingual mode, Korean-first prevents the English recognizer from
    # replacing recognizable Hangul with Latin guesses (verified on the fixture).
    return "kor+eng" if language == "eng+kor" else language


def pixmap(page, dpi):
    require(page.rect.width * page.rect.height * (dpi / 72) ** 2 <= MAX_PIXELS,
            "A page is too large at this resolution. Choose a lower DPI.")
    return page.get_pixmap(dpi=dpi, alpha=False)


def extract_pages(doc, selected, language, dpi):
    """Read native text first; recognize image-only pages locally."""
    rows = []
    for index in selected:
        page = doc[index]
        text = page.get_text(sort=True).strip()
        recognized = False
        if not text:
            # Dimension check before allocating the OCR image.
            require(page.rect.width * page.rect.height * (dpi / 72) ** 2 <= MAX_PIXELS,
                    "A page is too large at this resolution. Choose a lower DPI.")
            tp = page.get_textpage_ocr(language=recognition_language(language), dpi=dpi, full=True, tessdata=str(TESSDATA))
            text = page.get_text(textpage=tp, sort=True).strip()
            recognized = True
        rows.append({"page": index + 1, "text": text, "ocr": recognized})
    return rows


def translate_text(text, translator, tokenizer, source="en", target="ko"):
    # Preserve paragraph context (especially short greetings and polite endings).
    # Each bounded token batch is retained; no max_input_length truncation.
    sentences = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    translated = []
    for sentence in sentences:
        tokens = tokenizer.encode(sentence.replace("\n", " "), out_type=str)
        for offset in range(0, len(tokens), 256):
            source_tokens = [f"__{source}__"] + tokens[offset:offset + 256] + ["</s>"]
            result = translator.translate_batch([source_tokens], target_prefix=[[f"__{target}__"]], beam_size=5,
                                                max_decoding_length=768, max_input_length=0,
                                                repetition_penalty=1.0)[0]
            translated.append(tokenizer.decode(result.hypotheses[0][1:]).strip())
    return " ".join(translated)


def bilingual_pdf(path, rows, source, target):
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_LEFT
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
    from xml.sax.saxutils import escape
    pdfmetrics.registerFont(TTFont("UnifiedKorean", str(FONT)))
    normal = ParagraphStyle("body", fontName="UnifiedKorean", fontSize=10, leading=16,
                            wordWrap="CJK", spaceAfter=10, alignment=TA_LEFT)
    heading = ParagraphStyle("heading", parent=normal, fontSize=18, leading=25, textColor=colors.HexColor("#18343d"), spaceAfter=16)
    label = ParagraphStyle("label", parent=normal, fontSize=9, leading=13, textColor=colors.HexColor("#52636b"), spaceAfter=6)
    story = []
    def text_paragraphs(text):
        # Strip invalid controls; XML syntax is always escaped.
        clean = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
        return [Paragraph(escape(part).replace("\n", "<br/>"), normal) for part in clean.split("\n\n") if part.strip()]
    for row in rows:
        if story:
            story.append(PageBreak())
        story.append(Paragraph(f"{LANGUAGES[source]} / {LANGUAGES[target]}", heading))
        story.append(Paragraph(f"Source page {row['page']} - local machine translation", label))
        story.append(Paragraph("Original", label))
        story.extend(text_paragraphs(row["text"]) or [Paragraph("[No readable text]", normal)])
        story.append(Spacer(1, 14))
        story.append(Paragraph("Translation", label))
        story.extend(text_paragraphs(row["translation"]) or [Paragraph("[No readable text]", normal)])
    def footer(canvas, document):
        canvas.setFont("UnifiedKorean", 8)
        canvas.setFillColor(colors.HexColor("#52636b"))
        canvas.drawString(44, 24, "Unified Studio | Review machine translation before use")
        canvas.drawRightString(document.pagesize[0] - 44, 24, str(document.page))
    SimpleDocTemplate(str(path), pagesize=(595.276, 841.89), rightMargin=44, leftMargin=44,
                      topMargin=40, bottomMargin=48, title="Bilingual translation", author="Unified Studio").build(
                          story, onFirstPage=footer, onLaterPages=footer)


def do_docling(doc, selected, options, destination, details):
    import pymupdf as fitz
    import torch
    from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
    from docling.datamodel.base_models import InputFormat, ConversionStatus
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
    from docling.document_converter import DocumentConverter, PdfFormatOption
    language = options.get("language", "eng+kor")
    require(language in {"eng", "kor", "eng+kor", "kor+eng"}, "Choose English, Korean, or English + Korean OCR.")
    torch.set_num_threads(4)
    # Remove input password in memory and only place selected pages in a private
    # temporary directory; Docling never receives a password or original path.
    with tempfile.TemporaryDirectory(prefix="us-language-docling-") as scratch:
        temporary_pdf = Path(scratch) / "document.pdf"
        prepared = fitz.open()
        recognized = []
        try:
            for index in selected:
                if doc[index].get_text().strip():
                    prepared.insert_pdf(doc, from_page=index, to_page=index)
                else:
                    data = pixmap(doc[index], resolution(options)).pdfocr_tobytes(language=recognition_language(language), tessdata=str(TESSDATA))
                    with fitz.open("pdf", data) as page_pdf:
                        prepared.insert_pdf(page_pdf)
                    recognized.append(index + 1)
            prepared.save(temporary_pdf)
        finally:
            prepared.close()
        pipeline = PdfPipelineOptions(artifacts_path=ROOT / "docling-models", do_ocr=False,
                                      do_table_structure=True, enable_remote_services=False,
                                      allow_external_plugins=False, document_timeout=840,
                                      accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=4))
        pipeline.table_structure_options.mode = TableFormerMode.ACCURATE
        converter = DocumentConverter(allowed_formats=[InputFormat.PDF], format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline)})
        result = converter.convert(temporary_pdf, raises_on_error=True, max_num_pages=MAX_PAGES,
                                   max_file_size=MAX_BYTES)
        require(result.status == ConversionStatus.SUCCESS, "Docling could not extract every selected page.", "EXTRACTION_FAILED")
        structure = result.document.export_to_dict()
        structure["unified_studio"] = {"engine": "Docling 2.139.0", "offline": True,
                                       "sourcePages": [i + 1 for i in selected], "ocrPages": recognized,
                                       "models": ["docling-layout-heron", "TableFormer accurate"]}
        (destination / "docling.json").write_text(json.dumps(structure, ensure_ascii=False, indent=2), encoding="utf-8")
        (destination / "docling.md").write_text(result.document.export_to_markdown(), encoding="utf-8")
        details.update({"engine": "Docling 2.139.0", "models": ["docling-layout-heron", "TableFormer accurate"],
                        "tables": len(result.document.tables), "textItems": len(result.document.texts),
                        "ocrPages": recognized, "sourcePages": [i + 1 for i in selected],
                        "modelInference": True})
    return [destination / "docling.json", destination / "docling.md"]


def run(action, options):
    require(isinstance(options, dict), "Options must be an object.")
    if action == "capabilities":
        return {"ok": True, "outputs": [], "details": capabilities(), "warnings": []}
    require(action in {"translate", "ocr", "ai-extract"}, "Unsupported language action.", "UNKNOWN_ACTION")
    feature = {"translate": "translation", "ocr": "ocr", "ai-extract": "docling"}[action]
    require(capabilities()[feature]["available"], "The local language runtime or models are missing. Re-extract the complete application.", "CAPABILITY_UNAVAILABLE")
    inputs = options.get("inputs")
    require(isinstance(inputs, list) and len(inputs) == 1, "Select exactly one PDF document.")
    input_path = checked_path(inputs[0])
    output_parent = checked_path(options.get("outputDir"), directory=True)
    password = options.get("password", "")
    require(isinstance(password, str) and len(password) <= 1024, "The password must be text.")
    source, target = options.get("sourceLanguage", "en"), options.get("targetLanguage", "ko")
    if action == "translate":
        require((source, target) in {("en", "ko"), ("ko", "en")}, "Bundled translation supports English to Korean and Korean to English.")
    language = options.get("language", "eng+kor")
    require(language in {"eng", "kor", "eng+kor", "kor+eng"}, "Choose English, Korean, or English + Korean OCR.")
    dpi = resolution(options)
    started = time.monotonic()
    job = None
    warnings = []
    with offline():
        import pymupdf as fitz
        fitz.TOOLS.mupdf_display_errors(False)
        fitz.TOOLS.mupdf_display_warnings(False)
        try:
            with fitz.open(input_path) as doc:
                require(doc.is_pdf and 0 < doc.page_count <= 2000, "Select a valid PDF with at most 2000 pages.", "INVALID_PDF")
                if doc.needs_pass:
                    require(doc.authenticate(password), "Enter the correct PDF opening password.", "PASSWORD_REQUIRED")
                selected = pages(options.get("pages"), doc.page_count)
                if doc.metadata and doc.metadata.get("encryption"):
                    warnings.append("The output is unencrypted. Use Protect to apply a new opening password.")
                job = Path(tempfile.mkdtemp(prefix=f"Unified-PDF-{action}-{datetime.now():%Y%m%d-%H%M%S}-", dir=output_parent)).resolve()
                details = {"offline": True, "pageCount": len(selected), "outputDirectory": str(job)}
                if action == "translate":
                    import ctranslate2
                    import sentencepiece
                    rows = extract_pages(doc, selected, "eng" if source == "en" else "kor+eng", dpi)
                    require(any(row["text"] for row in rows), "No readable text was found in the selected pages.", "NO_TEXT")
                    require(sum(len(row["text"]) for row in rows) <= 300000, "Translate at most 300,000 characters per job. Choose fewer pages.")
                    model = ROOT / "m2m100-int8"
                    translator = ctranslate2.Translator(str(model), device="cpu", compute_type="int8", inter_threads=1, intra_threads=4)
                    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(model / "sentencepiece.bpe.model"))
                    for row in rows:
                        row["translation"] = translate_text(row["text"], translator, tokenizer, source, target)
                    bilingual_pdf(job / "bilingual-translation.pdf", rows, source, target)
                    (job / "translation.json").write_text(json.dumps({"engine": "M2M100-418M / CTranslate2 int8", "sourceLanguage": source,
                        "targetLanguage": target, "offline": True, "pages": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
                    markdown = "# Bilingual machine translation\n\n"
                    for row in rows:
                        markdown += f"## Source page {row['page']}\n\n### {LANGUAGES[source]}\n\n{row['text']}\n\n### {LANGUAGES[target]}\n\n{row['translation']}\n\n"
                    (job / "translation.md").write_text(markdown, encoding="utf-8")
                    output_files = [job / "bilingual-translation.pdf", job / "translation.json", job / "translation.md"]
                    details.update({"engine": "M2M100-418M / CTranslate2 int8", "sourceLanguage": source, "targetLanguage": target,
                                    "ocrPages": [r["page"] for r in rows if r["ocr"]], "sourcePages": [i + 1 for i in selected]})
                    warnings.append("Machine translation needs human review. The bilingual PDF is reflowed; original page layout, pictures, and formatting are not reproduced.")
                    warnings.append("Mixed pages with native text use that text; image text on those pages may require OCR first.")
                elif action == "ocr":
                    result = fitz.open()
                    rows = []
                    try:
                        for index in selected:
                            data = pixmap(doc[index], dpi).pdfocr_tobytes(language=recognition_language(language), tessdata=str(TESSDATA))
                            with fitz.open("pdf", data) as recognized:
                                rows.append({"page": index + 1, "text": recognized[0].get_text(sort=True).strip()})
                                result.insert_pdf(recognized)
                        result.save(job / "searchable.pdf", garbage=4, deflate=True)
                    finally:
                        result.close()
                    (job / "ocr.txt").write_text("\n\n".join(f"--- Page {r['page']} ---\n{r['text']}" for r in rows), encoding="utf-8")
                    (job / "ocr.json").write_text(json.dumps({"engine": "Tesseract", "language": language, "pages": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
                    output_files = [job / "searchable.pdf", job / "ocr.txt", job / "ocr.json"]
                    details.update({"engine": "Tesseract via PyMuPDF", "language": language, "sourcePages": [i + 1 for i in selected]})
                    warnings.append("OCR can misread text. The selected pages are rasterized at the selected DPI with a searchable text layer; interactive fields and signatures are not preserved in this copy.")
                    if not any(row["text"] for row in rows):
                        warnings.append("No text was recognized. Try a clearer scan or a different OCR language.")
                else:
                    output_files = do_docling(doc, selected, options, job, details)
                    warnings.append("Docling uses local layout and table models. Review reading order, Korean OCR, and table cells; extraction may be imperfect.")
                outputs = []
                for path in output_files:
                    require(path.is_file() and path.stat().st_size > 0, "The operation did not produce a valid output.", "OUTPUT_FAILED")
                    outputs.append({"path": str(path), "name": path.name, "bytes": path.stat().st_size})
                details["seconds"] = round(time.monotonic() - started, 3)
                return {"ok": True, "outputs": outputs, "details": details, "warnings": warnings}
        except Exception:
            if job and job.parent == output_parent and job.name.startswith("Unified-PDF-"):
                shutil.rmtree(job, ignore_errors=True)
            raise


def main():
    # Third-party library chatter must not enter the JSON protocol or expose
    # document text/passwords in host logs.
    sys.stdout.reconfigure(encoding="utf-8")
    logging.disable(logging.CRITICAL)
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        require(len(raw) <= 2 * 1024 * 1024, "Request exceeds the local worker size limit.")
        request = json.loads(raw.decode("utf-8"))
        require(isinstance(request, dict), "Request must be an object.")
        with open(os.devnull, "w", encoding="utf-8") as null, redirect_stdout(null), redirect_stderr(null):
            result = run(request.get("action"), request.get("options", {}))
    except LanguageError as error:
        result = {"ok": False, "outputs": [], "error": {"code": error.code, "message": error.message}}
    except (FileNotFoundError, PermissionError):
        result = {"ok": False, "outputs": [], "error": {"code": "FILE_ACCESS", "message": "A selected file or output folder is unavailable or not writable."}}
    except (ValueError, TypeError, json.JSONDecodeError):
        result = {"ok": False, "outputs": [], "error": {"code": "INVALID_OPTIONS", "message": "Check the PDF document and supplied options."}}
    except Exception:
        result = {"ok": False, "outputs": [], "error": {"code": "PROCESSING_FAILED", "message": "The local language operation could not finish. Try fewer pages or re-extract the complete app."}}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
