# Local background-removal notices

U²-Net is by Xuebin Qin and the U²-Net contributors. The upstream project is
distributed under Apache License 2.0. The full, unmodified Apache license is
retained as `U2NET-LICENSE.txt`. The bundled U²-Net ONNX model is obtained from
rembg's public v0.0.0 model release and mapped to that upstream U²-Net project.
No proprietary or paid model is included.

The U²-Net preprocessing and postprocessing behavior is adapted from rembg's
`rembg/sessions/u2net.py` and `rembg/sessions/base.py` at revision
`cd8f3665dda6c246b5baecb85fda6a2acd644c2a`.

Copyright (c) 2020 Daniel Gatis. MIT License. The full unmodified license is
retained as `REMBG-LICENSE.txt`; the corresponding original source files are
retained in `../upstream`. Changes in `remove.py` add local-only IPC, fixed model
selection, input/output bounds, model integrity checks, CPU thread limits,
existing-alpha preservation, input metadata removal and sanitized errors.

Python, ONNX Runtime, NumPy and Pillow are reused unmodified from the PDF
runtime. Their existing distribution notices and source materials apply.

The synthetic mannequin fixture was generated specifically for this app's
tests and uses no third-party photo, character design or personal image.
