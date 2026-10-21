# Original project and adaptation record — 2026-10-14

Original owner-provided project title: **PDF password unlock app**.
The existing implementation is the **Apple English — PDF Tools** project,
directory name `PDFToolbox`. Its location and title were verified locally.
Machine-specific location and session metadata are retained only in the local
investigation record, not this distributable source note.

Evidence was located by exact-title search within Claude's project index/history,
then targeted reads of this project's files. Unrelated conversation contents and
credentials were not copied into this integration or printed as evidence.

The original project was read, never edited. Reviewed source hashes:

| Original file | SHA-256 |
|---|---|
| `pdf_tools.py` | `47a92d4063d25caa124d2afe7199c46e3e78ac09a4b44f34b1b875d9f5aa5288` |
| `extras.py` | `0175be3ca8f3e9eb7b52e1079904d52737fa44aed71b6b42caefd7d3ac743945` |
| `requirements.txt` | `1ab1ba19b469705cfeeaddbf3d507cb32e0c7010f1c04e2fc9cbe30349db2fd18` |
| `README.md` | `41d1cc5d179c710a42dc462f53c7c5846870e8e75d6b5a9a1d875eceba928e55` |

The isolated adaptation preserves the useful local PDF workflows while adding
strict page/path validation, isolated subprocess IPC, portable pinned runtime,
input-preserving output directories, password-safe errors, real redaction,
rotated preview coordinates, explicit conversion limits, and tested cancellation.

The original README overstates several optional/fallback capabilities. This
integration does not claim that best-effort metadata creates valid PDF/A, that
an approximate text renderer preserves Office layout, that online translation
is offline, or that unknown strong passwords are always recoverable. Only
user-supplied password candidates are tested, under fixed count/time limits.
Docling and offline translation models are not bundled. Rich local text/layout
extraction and English/Chinese OCR work without network services.

Original working environment verified: Python 3.14.0, PyMuPDF 1.27.2.3, pikepdf
10.8.0 and Pillow 12.2.0. These packages and their required local dependencies
were copied from installed distribution records into a separate runtime; the
original virtual environment remains unchanged.
