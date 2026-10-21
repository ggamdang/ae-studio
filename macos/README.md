# AE Studio 0.9.1 for Apple-silicon Mac — preview

Requires an Apple-silicon Mac (M1 or newer), macOS 15 or newer. Intel Macs are not supported by this companion build. Back up important documents before testing a preview.

Open the .pkg installer and follow Installer. The apps are installed together in /Applications/AE Studio. Open AE Studio.app for the home screen, PDF tools, ArtCraft workspace and account settings. Each original Craft editor opens in its own window; you can open those apps directly from the Apps folder.

In Finder, right-click a supported file, choose Open With, then AE Studio (or choose Other and locate it). To make that choice permanent for a file type: Get Info → Open with → AE Studio → Change All. The installer does not replace existing defaults. Files on connected external disks and mounted network shares use their ordinary /Volumes paths; the share must be mounted and writable to save there. Cloud placeholders may need downloading first.

This is an unsigned preview, not an Apple-notarized release. macOS may require an explicit Open Anyway decision in Privacy & Security. Do not disable Gatekeeper. Original native bundle signatures are checked during assembly; successful CI tests do not prove first-launch acceptance on every personal Mac.

The package includes the original 13 native Craft editors, the reviewed ArtCraft workspace, PDF processing, offline English ↔ Korean translation/OCR, Docling document extraction, LibreOffice conversion and HWP/HWPX import to editable DOCX copies. These are open-source capabilities, not a promise of every Microsoft Office or Adobe Acrobat feature. VBA, DRM, proprietary formats, cloud e-signature workflows and perfect layout preservation are not guaranteed. Native editors remain upstream alpha/development software. Their own online AI features may require a separate upstream account or credits; connecting a subscription in AE Studio does not automatically unlock those services.

For local image generation, open AI Studio, read and accept the model license, then choose Set up free local AI. This downloads about 7 GB and needs 15 GB of free storage. SDXL requires at least 12 GB RAM (16 GB recommended). The model is not active merely by installing the main package. Google, ChatGPT and Claude each require a fresh personal sign-in; tokens are never included. Account eligibility and subscription limits still apply. The Google desktop client configuration must be imported in Accounts if it is absent. No paid API fallback is enabled.

The format guide lists routing, conversion and limitations. Verification contains actual automated results from a GitHub-hosted Mac. Personal-account sign-in, a physical Mac's Metal image generation, printers, and real network/cloud shares require testing on the target device. Do not infer these from the automated checks.

PDF/A conversion accepts a copy only after veraPDF validates it. A WordCraft-generated PDF in testing exposed an embedded-font width mismatch during conversion; it was correctly rejected, with the original preserved. Some ordinary PDFs therefore cannot be converted by this engine. Re-exporting from the original document may help; do not treat a rejected copy as an archival PDF.

Source and third-party notices accompany the software. AE Studio source is AGPL-3.0-or-later. Other components retain their own licenses. Original Craft marks identify their authors and do not imply that they endorse AE Studio. Preserve Source and Third-party notices when sharing. This package is not a commercial rights-clearance opinion.

To remove the suite, quit its apps and move /Applications/AE Studio to Trash. Personal settings and local AI downloads remain in ~/Library/Application Support/AE Studio; remove them separately only if you no longer need them. Documents are not deleted.
