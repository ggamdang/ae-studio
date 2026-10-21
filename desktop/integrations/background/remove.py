"""Bounded, offline U²-Net background-removal worker for the ArtCraft bridge.

Protocol: one JSON object {imageBase64} on stdin, one result on stdout. Source
images never leave memory. Only the fixed bundled model is read from disk.
Pre/postprocessing follows the pinned MIT-licensed rembg session sources kept
under upstream/. No rembg installation or runtime model download is used.
"""
from __future__ import annotations

import base64
import binascii
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import sys
import warnings

HERE = Path(__file__).resolve().parent
MODEL = HERE / "models" / "u2net.onnx"
MODEL_SHA256 = "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491"
MAX_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 30_000_000
MAX_BASE64 = 4 * ((MAX_BYTES + 2) // 3)
MAX_REQUEST = MAX_BASE64 + 1024
_SESSION = None


class ImageError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def require(condition, message, code="INVALID_IMAGE"):
    if not condition:
        raise ImageError(code, message)


def _session():
    global _SESSION
    if _SESSION is None:
        import onnxruntime as ort
        require(MODEL.is_file(), "The local background-removal model is missing.", "MODEL_UNAVAILABLE")
        with MODEL.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        require(digest == MODEL_SHA256, "The local background-removal model failed its integrity check.", "MODEL_INTEGRITY")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.log_severity_level = 3
        _SESSION = ort.InferenceSession(str(MODEL), sess_options=options, providers=["CPUExecutionProvider"])
        require(_SESSION.get_providers() == ["CPUExecutionProvider"], "The local CPU inference provider is unavailable.", "MODEL_UNAVAILABLE")
    return _SESSION


def remove_background(request):
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    require(isinstance(request, dict) and set(request) == {"imageBase64"},
            "Supply one image as base64 data.", "INVALID_REQUEST")
    encoded = request.get("imageBase64")
    require(isinstance(encoded, str) and 0 < len(encoded) <= MAX_BASE64,
            "Images must be nonempty and at most 32 MB.", "INPUT_TOO_LARGE")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ImageError("INVALID_IMAGE", "The supplied image data is not valid base64.")
    require(0 < len(data) <= MAX_BYTES, "Images must be nonempty and at most 32 MB.", "INPUT_TOO_LARGE")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as opened:
                require(opened.format in {"PNG", "JPEG", "WEBP", "BMP", "TIFF"},
                        "Choose a PNG, JPEG, WebP, BMP or TIFF image.")
                require(opened.width > 0 and opened.height > 0 and opened.width * opened.height <= MAX_PIXELS,
                        "Choose an image with at most 30 million pixels.", "IMAGE_TOO_LARGE")
                require(getattr(opened, "n_frames", 1) == 1, "Choose a still image with one frame.")
                rgba = ImageOps.exif_transpose(opened).convert("RGBA")
    except ImageError:
        raise
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise ImageError("IMAGE_TOO_LARGE", "Choose an image with at most 30 million pixels.")
    except (UnidentifiedImageError, OSError, ValueError):
        raise ImageError("INVALID_IMAGE", "The image could not be decoded. It may be damaged or unsupported.")
    require(rgba.getchannel("A").getbbox() is not None, "This image has no visible pixels.", "NO_FOREGROUND")
    # Composite existing transparency against white for inference, but multiply
    # the inferred mask with the original alpha so hidden pixels stay hidden.
    inference = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    inference.alpha_composite(rgba)
    reduced = inference.convert("RGB").resize((320, 320), Image.Resampling.LANCZOS)
    pixels = np.asarray(reduced, dtype=np.float32)
    require(float(np.max(pixels.max(axis=(0, 1)) - pixels.min(axis=(0, 1)))) > 1,
            "No foreground object could be found in this uniform image.", "NO_FOREGROUND")
    pixels /= max(float(pixels.max()), 1e-6)
    pixels = (pixels - np.array((.485, .456, .406), dtype=np.float32)) / np.array((.229, .224, .225), dtype=np.float32)
    tensor = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None, ...], dtype=np.float32)
    session = _session()
    prediction = session.run(None, {session.get_inputs()[0].name: tensor})[0][0, 0]
    require(bool(np.isfinite(prediction).all()), "The local model returned an invalid mask.", "PROCESSING_FAILED")
    low, high = float(prediction.min()), float(prediction.max())
    require(high - low > 1e-6, "No foreground object could be separated from this image.", "NO_FOREGROUND")
    prediction = np.clip((prediction - low) / (high - low), 0, 1)
    mask = Image.fromarray((prediction * 255).astype(np.uint8)).resize(rgba.size, Image.Resampling.LANCZOS)
    original_alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint16)
    alpha = ((np.asarray(mask, dtype=np.uint16) * original_alpha + 127) // 255).astype(np.uint8)
    rgba.putalpha(Image.fromarray(alpha))
    result = io.BytesIO()
    # Re-encode only pixel data: do not propagate EXIF, paths or source metadata.
    rgba.save(result, format="PNG", compress_level=6)
    payload = result.getvalue()
    require(len(payload) <= MAX_BYTES, "The transparent PNG exceeds 32 MB. Resize the image and try again.", "OUTPUT_TOO_LARGE")
    return {"ok": True, "pngBase64": base64.b64encode(payload).decode("ascii"),
            "width": rgba.width, "height": rgba.height}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        require(len(raw) <= MAX_REQUEST, "The image request exceeds 32 MB of decoded data.", "INPUT_TOO_LARGE")
        request = json.loads(raw.decode("utf-8"))
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = remove_background(request)
    except ImageError as error:
        result = {"ok": False, "error": {"code": error.code, "message": error.message}}
    except (json.JSONDecodeError, UnicodeDecodeError):
        result = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": "Supply a valid image request."}}
    except ImportError:
        result = {"ok": False, "error": {"code": "RUNTIME_UNAVAILABLE", "message": "The local image runtime is unavailable."}}
    except Exception:
        result = {"ok": False, "error": {"code": "PROCESSING_FAILED", "message": "The local model could not remove this background. Try a smaller image with a clear foreground object."}}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
