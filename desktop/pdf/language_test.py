"""Meaningful offline integration checks with synthetic documents only."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import advanced_language as worker
import pymupdf as fitz
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = HERE / "language-build" / ("verification-" + str(uuid.uuid4()))
ROOT.mkdir(parents=True)
tempfile.tempdir = str(ROOT)
REPORT = {"directory": str(ROOT), "checks": [], "results": {}}


def check(name, condition, **evidence):
    assert condition, (name, evidence)
    REPORT["checks"].append({"name": name, "passed": True, **evidence})
    print("PASS", name, flush=True)


def make_text(path, text):
    doc = canvas.Canvas(str(path), pagesize=(595.276, 841.89))
    doc.setFont("Korean", 19)
    y = 780
    for line in text.splitlines():
        doc.drawString(50, y, line)
        y -= 32
    doc.save()


def request(action, path, **options):
    start = time.monotonic()
    result = worker.run(action, {"inputs": [str(path)], "outputDir": str(ROOT), **options})
    REPORT["results"][action + str(len(REPORT["results"]))] = result
    check(action + " succeeded", result["ok"], seconds=round(time.monotonic() - start, 2))
    check(action + " fresh output boundary", all(Path(x["path"]).parent.parent == ROOT and
          Path(x["path"]).parent.name.startswith("Unified-PDF-" + action + "-") for x in result["outputs"]))
    return result


def output(result, suffix):
    return next(Path(x["path"]) for x in result["outputs"] if x["name"].endswith(suffix))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    pdfmetrics.registerFont(TTFont("Korean", str(worker.FONT)))
    english, korean = ROOT / "english.pdf", ROOT / "korean.pdf"
    make_text(english, "Hello. Welcome to our school.\nThe students read books every day.\nPlease open the door. Thank you.")
    make_text(korean, "안녕하세요. 우리 학교에 오신 것을 환영합니다.\n학생들은 매일 책을 읽습니다.\n문을 열어 주세요. 감사합니다.")
    scanned = ROOT / "korean-scan.pdf"
    with fitz.open(korean) as source, fitz.open() as scan:
        pix = source[0].get_pixmap(dpi=220, alpha=False)
        page = scan.new_page(width=source[0].rect.width, height=source[0].rect.height)
        page.insert_image(page.rect, stream=pix.tobytes("png"))
        scan.save(scanned)
    with fitz.open(scanned) as scan:
        check("scan has no existing text", not scan[0].get_text().strip())
    baseline = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (english, korean, scanned)}
    check("all models ready", worker.capabilities()["available"])
    with worker.offline():
        try:
            socket.create_connection(("example.com", 443))
            raise AssertionError("network unexpectedly allowed")
        except worker.LanguageError as exc:
            check("worker denies network", exc.code == "OFFLINE_ONLY")
    result = request("translate", english, sourceLanguage="en", targetLanguage="ko")
    data = json.loads(output(result, ".json").read_text(encoding="utf-8"))
    check("English to Korean generated Hangul", bool(re.search("[가-힣]", data["pages"][0]["translation"])), translation=data["pages"][0]["translation"])
    with fitz.open(output(result, ".pdf")) as doc:
        check("bilingual PDF contains source and Korean", "students" in doc[0].get_text() and bool(re.search("[가-힣]", doc[0].get_text())))
        doc[0].get_pixmap(dpi=110).save(ROOT / "english-korean-preview.png")
    result = request("translate", korean, sourceLanguage="ko", targetLanguage="en")
    data = json.loads(output(result, ".json").read_text(encoding="utf-8"))
    check("Korean to English generated English", "school" in data["pages"][0]["translation"].lower(), translation=data["pages"][0]["translation"])
    with fitz.open(output(result, ".pdf")) as doc:
        doc[0].get_pixmap(dpi=110).save(ROOT / "korean-english-preview.png")
    result = request("ocr", scanned, language="eng+kor", dpi=250)
    with fitz.open(output(result, ".pdf")) as doc:
        extracted = doc[0].get_text()
        check("Korean OCR reads known scan", "학교" in re.sub(r"\s+", "", extracted) and "학생" in extracted, text=extracted)
        doc[0].get_pixmap(dpi=110).save(ROOT / "korean-ocr-preview.png")
    # Real table fixture for the layout and TableFormer inference paths.
    table_pdf = ROOT / "table.pdf"
    c = canvas.Canvas(str(table_pdf), pagesize=(595.276, 841.89))
    c.setFont("Helvetica-Bold", 22)
    c.drawString(50, 780, "Classroom supply report")
    c.setFont("Helvetica", 12)
    c.drawString(50, 745, "The following table lists supplies for the English classroom.")
    values = [["Item", "Quantity", "Cost"], ["Books", "24", "120"], ["Pencils", "30", "15"], ["Folders", "18", "36"]]
    for r, row in enumerate(values):
        y = 690 - r * 42
        for col, text in enumerate(row):
            c.rect(50 + col * 160, y - 15, 160, 42)
            c.drawString(60 + col * 160, y, text)
    c.save()
    # Count true neural model calls, not only presence of output files.
    from transformers import RTDetrV2ForObjectDetection
    from docling_ibm_models.tableformer.data_management.tf_predictor import TFPredictor
    counts = {"layoutForward": 0, "tablePredict": 0}
    original_forward, original_predict = RTDetrV2ForObjectDetection.forward, TFPredictor.predict
    def forward(self, *args, **kwargs):
        counts["layoutForward"] += 1
        return original_forward(self, *args, **kwargs)
    def predict(self, *args, **kwargs):
        counts["tablePredict"] += 1
        return original_predict(self, *args, **kwargs)
    RTDetrV2ForObjectDetection.forward, TFPredictor.predict = forward, predict
    try:
        result = request("ai-extract", table_pdf)
    finally:
        RTDetrV2ForObjectDetection.forward, TFPredictor.predict = original_forward, original_predict
    structure = json.loads(output(result, ".json").read_text(encoding="utf-8"))
    check("actual layout and table inference executed", counts["layoutForward"] > 0 and counts["tablePredict"] > 0, **counts)
    check("Docling produced structured table cells", len(structure["tables"]) >= 1 and structure["tables"][0]["data"]["num_cols"] == 3,
          tables=len(structure["tables"]), tableData=structure["tables"][0]["data"])
    check("Docling markdown retains fixture data", all(word in output(result, ".md").read_text(encoding="utf-8") for word in ("Books", "Pencils", "Folders", "120")))
    scanned_translation = request("translate", scanned, sourceLanguage="ko", targetLanguage="en")
    scan_data = json.loads(output(scanned_translation, ".json").read_text(encoding="utf-8"))
    check("scanned Korean translated after local OCR", scan_data["pages"][0]["ocr"] and "school" in scan_data["pages"][0]["translation"].lower(), translation=scan_data["pages"][0]["translation"])
    scanned_docling = request("ai-extract", scanned, language="eng+kor")
    check("Docling processes Korean scan through local OCR", scanned_docling["details"]["ocrPages"] == [1] and "학생" in output(scanned_docling, ".md").read_text(encoding="utf-8"))
    # Exercise the exact isolated invocation and sanitized environment used by Electron.
    clean_env = {"SystemRoot": os.environ.get("SystemRoot", r"C:\Windows"), "WINDIR": os.environ.get("WINDIR", r"C:\Windows"),
                 "TEMP": str(ROOT), "TMP": str(ROOT), "PATH": str(HERE / "runtime")}
    payload = {"action": "translate", "options": {"inputs": [str(english)], "outputDir": str(ROOT), "sourceLanguage": "en", "targetLanguage": "ko"}}
    completed = subprocess.run([str(worker.PYTHON), "-I", "-B", str(HERE / "advanced_language.py")], input=json.dumps(payload).encode(),
                               capture_output=True, timeout=180, env=clean_env)
    cli = json.loads(completed.stdout)
    check("sanitized CLI works", cli["ok"], error=cli.get("error"))
    locked = ROOT / "locked.pdf"
    with fitz.open(english) as doc:
        doc.save(locked, encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="synthetic-secret-only", owner_pw="owner-synthetic-secret")
    payload["options"].update({"inputs": [str(locked)], "password": "wrong-synthetic-password"})
    completed = subprocess.run([str(worker.PYTHON), "-I", "-B", str(HERE / "advanced_language.py")], input=json.dumps(payload).encode(),
                               capture_output=True, timeout=30, env=clean_env)
    failure = json.loads(completed.stdout)
    check("password failure is safe", not failure["ok"] and failure["error"]["code"] == "PASSWORD_REQUIRED" and b"wrong-synthetic-password" not in completed.stdout + completed.stderr)
    check("original PDF bytes preserved", all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in baseline.items()))
    for bad_options in ({"pages": "0"}, {"sourceLanguage": "ko", "targetLanguage": "ko"}, {"dpi": True}):
        try:
            request("translate", english, **bad_options)
            raise AssertionError("invalid options accepted")
        except worker.LanguageError:
            check("invalid option rejected " + str(bad_options), True)
    REPORT["passed"] = True
    import shutil
    fixtures = HERE / "language-fixtures"
    fixtures.mkdir(exist_ok=True)
    for name in ("english.pdf", "korean.pdf", "korean-scan.pdf", "table.pdf", "english-korean-preview.png", "korean-english-preview.png", "korean-ocr-preview.png"):
        shutil.copy2(ROOT / name, fixtures / name)
    (HERE / "language-test-report.json").write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "checks": len(REPORT["checks"]), "directory": str(ROOT)}), flush=True)


if __name__ == "__main__":
    main()
