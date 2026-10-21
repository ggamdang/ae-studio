# Components used in the Mac preview

The original Craft editors retain their own workspaces and features. AE Studio adds a shared home, file routing, account setup, ArtCraft workspace and document tools. The pinned versions and download hashes are recorded in the build manifests; test results describe the checks actually run.

| Project | Role in this package | Practical limit |
|---|---|---|
| [Storytold Craft apps](https://getartcraft.com/apps) | Thirteen original native editors, with their own import/export engines | Upstream development releases; format variants and advanced workflows need individual checks |
| [ArtCraft](https://github.com/storytold/artcraft) | Local canvas, drawing, masks, 3D scenes, posing, image import, project saving and reopening | Hosted ArtCraft services and credits are separate; the local workspace does not reproduce their servers |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | Optional local image-generation runtime and SDXL setup | The model downloads separately after license acceptance; real Metal generation needs target-device testing |
| [LibreOffice](https://github.com/LibreOffice/core) | Local Office conversion | Converted layout, macros, charts and embedded objects may differ |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) and [pikepdf](https://github.com/pikepdf/pikepdf) | PDF rendering, editing, page operations, protection and conversion | Processing limits depend on the operation; sharing includes source and license materials |
| [pyHanko](https://github.com/MatthiasValvekens/pyHanko) and [veraPDF](https://github.com/veraPDF/veraPDF-library) | Local certificate signing/verification and PDF/A checks | A local signature is not a hosted signer-invitation service or an automatic trust guarantee |
| [Docling](https://github.com/docling-project/docling) | Local document layout and table extraction | Neural extraction is approximate and needs review on important documents |
| [hwp-cli](https://github.com/STAIxBWLB/hwp-cli) | HWP/HWPX import as new DOCX copies | Does not provide in-place Hancom editing or perfect format fidelity |

[OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) was also reviewed. Its searchable-scan workflow overlaps the package's existing OCR tools; it has not been added to this preview. Future additions should address a demonstrated missing workflow and include installation, export, licensing and regression checks.

No repository can establish that every feature works with every file. The file-format guide distinguishes routing and conversion, and the Verification folder records the tested examples. The package does not include paid API fallback, provider credits, remote e-signature infrastructure, or proprietary Office/Adobe plugins.
