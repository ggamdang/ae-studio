# Local background removal

`remove.py` provides the ArtCraft image editor with an entirely local U²-Net
foreground cutout. It reuses the bundled PDF runtime's Python 3.14,
ONNX Runtime 1.27.0, NumPy 2.4.6 and Pillow 12.2.0. No rembg installation,
cloud service, paid model, runtime download or private-image upload is used.

Run from the native bridge:

```text
pdf/runtime/python.exe -I -B integrations/background/remove.py
```

Write one JSON object to stdin and close stdin:

```json
{"imageBase64":"<raw base64 encoded image bytes>"}
```

The response is `{ok: true, pngBase64, width, height}` for a transparent PNG, or
`{ok: false, error: {code, message}}`. Base64 fields contain raw encoded bytes
without a data-URL prefix. No source/destination/model paths are accepted.

Decoded input and output are each limited to 32 MiB; input images are limited
to 30 million pixels. The maximum encoded field is 44,739,244 characters.
Allow at most that size plus a small JSON envelope on both IPC/stdout sides;
the parent must enforce its three-minute timeout and terminate the child on
cancellation. The worker accepts one-frame PNG, JPEG, WebP, BMP and TIFF.
EXIF rotation is applied, dimensions are preserved afterward, source metadata
is stripped, and original alpha is multiplied by the inferred alpha so already
transparent areas cannot become opaque.

The model uses four intra-operation CPU threads and one inter-operation thread.
Its SHA-256 is verified before ONNX Runtime loads it. Preprocessing and mask
normalization follow the exact retained rembg U2netSession and BaseSession
sources, with explicit bounds and a guard for constant/invalid masks added here.

U²-Net is a general salient-object model. Fine hair, transparent objects,
multiple disconnected subjects and busy backgrounds can require manual edge
cleanup. This feature does not claim perfect masks or studio-quality matting.

## Pinned model and provenance

- Model URL: [rembg's U²-Net ONNX release](https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx).
- Model SHA-256: `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491`.
- Model MD5 matches the upstream session's expected checksum:
  `60024c5c889badc19c04ad937298a77b`.
- [U²-Net upstream source and Apache 2.0 license](https://github.com/xuebinqin/U-2-Net/tree/ac7e1c817ecab7c7dff5ce6b1abba61cd213ff29).
- [rembg preprocessing/session source and MIT license](https://github.com/danielgatis/rembg/tree/cd8f3665dda6c246b5baecb85fda6a2acd644c2a).

Exact session source files, architecture source, original license files and
README are retained in `upstream`. Notices are in `notices`. `manifest.json`
records hashes for the model and retained upstream materials. This worker is a
local adaptation of the preprocessing/postprocessing behavior, not an installed
copy of the rembg application. The source image never leaves process memory.

## Validation evidence

`test_background.py` tests the actual isolated CLI with an original procedurally
rendered ellipsoid mannequin, checks foreground/background against its known
silhouette, checks preservation of existing alpha, and rejects malformed data,
arbitrary paths, oversized encoded input, oversized dimensions, invalid JSON and
uniform images. Run it with the same bundled Python executable.

The original fixture and output are in `qa`; they contain no third-party photo
or personal image. `checker-preview.png` was visually inspected. The tested
768×768 image retained 99.64% of the known foreground at alpha >128 and retained
0.016% of the known background. 80.52% of output pixels had alpha <5. These
numbers describe this synthetic test, not all photographs.

The app bundle needs `remove.py`, `models/u2net.onnx`, notices and the manifest.
Source distribution should also retain `upstream`, this README and tests.
The synthetic `qa` images and test log may be kept as review evidence.
