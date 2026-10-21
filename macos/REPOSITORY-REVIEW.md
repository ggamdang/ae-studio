# AE Studio Mac integration review — 2026-10-21

The target is the original native Craft editors plus AE Studio's companion tools.
The original editors remain separate applications. No repository can establish
complete Microsoft Office, Adobe Creative Cloud or Acrobat feature parity.

| Repository | Role | Decision |
|---|---|---|
| [storytold Craft applications](https://getartcraft.com/apps) | Thirteen native document/creative editors | Preserve original signed Mac bundles and pinned versions; test actual import/export and opening. These are upstream alpha/development apps. |
| [storytold/artcraft](https://github.com/storytold/artcraft) | Canvas and 3D workspace | Reuse the reviewed source adapter and asset allow-list. Private hosted services are not included. |
| [LibreOffice/core](https://github.com/LibreOffice/core) | Legacy Office conversion | Bundle the original Mac conversion engine. No macro execution. Preserve source files and create new converted copies. |
| [pymupdf/PyMuPDF](https://github.com/pymupdf/PyMuPDF) and [qpdf/qpdf](https://github.com/qpdf/qpdf) | PDF rendering, editing, encryption and structure | Retain existing tested engine. QPDF is used through pikepdf. Ship AGPL source/license materials. |
| [tesseract-ocr/tesseract](https://github.com/tesseract-ocr/tesseract) | English/Korean OCR | Retain local OCR and language data; test on the Mac runtime. |
| [MatthiasValvekens/pyHanko](https://github.com/MatthiasValvekens/pyHanko) and [veraPDF/veraPDF-apps](https://github.com/veraPDF/veraPDF-apps) | Certificate signatures and PDF/A validation | Port the existing workflows. Certificate issuance, remote signing ceremonies and paid timestamp services are separate products. |
| [docling-project/docling](https://github.com/docling-project/docling) | Local structured PDF extraction | Retain the two local layout/table models; test ordering and table output. |
| [STAIxBWLB/hwp-cli](https://github.com/STAIxBWLB/hwp-cli) | Hangul import | Use the native Apple-silicon release. Convert to DOCX; not lossless HWP editing/export. |
| [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) | Local image generation | Use Apple MPS/CPU instead of CUDA. Model/license acceptance stays explicit. GPU and memory acceptance still require suitable hardware. |
| [ocrmypdf/OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) | Alternative archival OCR pipeline | Useful future addition, but does not replace all editing/signing tools. Avoid adding a second OCR stack until a specific quality gap is demonstrated. |

Do not add arbitrary plugins or custom ComfyUI nodes automatically. Every added
dependency needs a concrete purpose, redistribution review and an executable
test. More dependencies alone do not improve document fidelity.

## Release gates

- All 13 native import/export tests pass on an Apple-silicon Mac runner.
- Mac companion workers, translation/extraction, UI and file delivery pass.
- Installer relocation and installed payload checks pass.
- Source/license materials and a format-by-format list accompany the package.
- No accounts, user documents, browser profiles or API keys enter artifacts.
- Cloud sign-in, GPU performance, external/network volumes and physical Finder
  acceptance must be reported separately from automated CI evidence.

Standard public GitHub Mac runners only; no paid runners, API calls, signing
subscription or account upgrade is authorized by this build.
