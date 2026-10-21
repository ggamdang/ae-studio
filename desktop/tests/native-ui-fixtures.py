"""Synthetic inputs and independent checks for the native-tools UI smoke run."""
import json
import sys
from pathlib import Path

import pymupdf as fitz
import pikepdf
from PIL import Image, ImageDraw


def create(root):
    root.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    page = doc.new_page(width=400, height=500)
    page.insert_text((35, 40), "Native tools verification", fontsize=18)
    page.insert_text((35, 75), "Synthetic file. No personal information.", fontsize=11)
    page.insert_text((35, 120), "SECRET-ACCOUNT-12345", fontsize=12)
    page.insert_text((35, 160), "This public sentence remains visible.", fontsize=11)
    for name, kind, rect, value, flags in [
        ("student_name", fitz.PDF_WIDGET_TYPE_TEXT, (35, 190, 250, 220), "Before", 0),
        ("consent", fitz.PDF_WIDGET_TYPE_CHECKBOX, (35, 245, 55, 265), False, 0),
        ("locked_note", fitz.PDF_WIDGET_TYPE_TEXT, (35, 280, 250, 305), "Read only", 1),
    ]:
        widget = fitz.Widget()
        widget.field_name = name
        widget.field_type = kind
        widget.rect = fitz.Rect(rect)
        widget.field_value = value
        widget.field_flags = flags
        widget.text_fontsize = 12
        widget.border_width = 1
        widget.border_color = (0.4, 0.4, 0.4)
        page.add_widget(widget)
    page.insert_text((65, 260), "Consent (initially unchecked)", fontsize=10)
    doc.new_page(width=400, height=500).insert_text((35, 60), "Second synthetic page", fontsize=16)
    doc.set_metadata({"title": "Synthetic native UI verification"})
    doc.embfile_add("hidden-proof.txt", b"Synthetic attachment for redaction scrub check.")
    doc.save(root / "form-and-marks.pdf")
    doc.close()
    other = fitz.open()
    other.new_page(width=300, height=300).insert_text((30, 50), "Different first document", fontsize=13)
    other.save(root / "different.pdf")
    other.close()
    image = Image.new("RGBA", (420, 110), (255, 255, 255, 0))
    draw = ImageDraw.Draw(image)
    draw.line([(12, 75), (40, 25), (28, 85), (65, 55), (78, 75), (110, 35), (115, 70), (160, 50), (190, 72), (240, 33), (232, 76), (290, 57), (340, 70), (398, 38)], fill=(30, 55, 105, 255), width=5)
    draw.line([(30, 92), (385, 86)], fill=(30, 55, 105, 255), width=3)
    image.save(root / "synthetic-signature.png")
    (root / "static.html").write_text("<!doctype html><html><body><h1>Local HTML proof</h1><p>Converted locally from a synthetic HTML file.</p></body></html>", encoding="utf-8")
    print(json.dumps({"created": str(root)}))


def verify(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    root = manifest_path.parent
    results = {}
    for action, name in manifest.items():
        with fitz.open(name) as doc:
            text = "\n".join(page.get_text() for page in doc)
            for number, page in enumerate(doc):
                suffix = "" if number == 0 else "-page-" + str(number + 1)
                page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6), alpha=False).save(root / ("result-" + action + suffix + ".png"))
            if action == "watermark":
                assert "REVIEW COPY" in text
            elif action == "fill-form":
                widget_values = {widget.field_name: widget.field_value for page in doc for widget in (page.widgets() or [])}
                assert widget_values["student_name"] == "Alice Example", widget_values
                assert widget_values["consent"] not in ("Off", "/Off", "", False), widget_values
                assert widget_values["locked_note"] == "Read only", widget_values
                with pikepdf.open(name) as canonical:
                    fields = {str(field.T): str(field.get("/V", "")) for field in canonical.Root.AcroForm.Fields}
                    assert fields["student_name"] == "Alice Example", fields
                    assert fields["consent"] not in ("Off", "/Off", ""), fields
                    assert fields["locked_note"] == "Read only", fields
                    results["canonicalFormValues"] = fields
            elif action == "add-text":
                assert "Added through the Studio UI" in text, text
            elif action == "annotate":
                notes = [a.info.get("content") for page in doc for a in (page.annots() or [])]
                assert "Synthetic review note" in notes, notes
            elif action == "sign":
                assert len(doc[0].get_images()) >= 1
            elif action == "redact":
                assert "SECRET-ACCOUNT-12345" not in text
                assert doc.embfile_count() == 0
                assert not any(widget for page in doc for widget in (page.widgets() or []))
                pix = doc[0].get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
                assert max(pix.pixel(100, 115)[:3]) < 20, pix.pixel(100, 115)
                assert min(pix.pixel(100, 145)[:3]) > 230, pix.pixel(100, 145)
                with pikepdf.open(name) as canonical:
                    assert "/AcroForm" not in canonical.Root or not canonical.Root.AcroForm.get("/Fields")
            elif action == "html-to-pdf":
                assert "Local HTML proof" in text, text
        results[action] = {"passed": True, "file": name}
    print(json.dumps(results))


if __name__ == "__main__":
    {"create": create, "verify": verify}[sys.argv[1]](Path(sys.argv[2]))
