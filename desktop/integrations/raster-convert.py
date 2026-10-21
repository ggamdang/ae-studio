"""Decode supported interchange images to a new PNG, never overwrite an input."""
import json, sys, warnings
from pathlib import Path
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 60_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
try:
    source, destination = map(Path, sys.argv[1:3])
    if source.suffix.lower() not in {'.avif'} or not source.is_file() or not 0 < source.stat().st_size <= 256*1024**2:
        raise ValueError('Choose a supported image up to 256 MB.')
    with Image.open(source) as image:
        if image.width*image.height > 60_000_000:
            raise ValueError('The decoded image exceeds 60 million pixels.')
        # Still-image import: preserve orientation and alpha; discard optional metadata.
        converted = ImageOps.exif_transpose(image).convert('RGBA')
        with destination.open('xb') as out:
            converted.save(out, format='PNG')
    print(json.dumps({'ok': True}))
except Exception:
    print(json.dumps({'ok': False, 'error': 'This image could not be converted within the 60-million-pixel limit. Animated AVIF imports its first frame only.'}))
    sys.exit(1)
