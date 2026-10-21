"""Independently decode FilmCraft exports and compare their actual pixels."""
import hashlib,json,pathlib,sys
import cv2
import numpy as np
from PIL import Image

source,still,video,out=map(pathlib.Path,sys.argv[1:])
out.mkdir(parents=True,exist_ok=True)
before=hashlib.sha256(source.read_bytes()).hexdigest()
with Image.open(source) as image:expected=np.asarray(image.convert('RGB'),dtype=np.float32)
with Image.open(still) as image:actual=np.asarray(image.convert('RGB'),dtype=np.float32)
assert actual.shape==expected.shape==(120,160,3), 'Export dimensions changed'
assert float(expected.std())>20, 'Fixture must contain visible variation'
still_error=float(np.abs(expected-actual).mean())
assert still_error<=1, f'Still-frame pixels differ: {still_error}'
capture=cv2.VideoCapture(str(video));errors=[]
try:
    assert capture.isOpened(), 'Independent decoder cannot open MP4'
    fps=capture.get(cv2.CAP_PROP_FPS)
    assert abs(fps-29.97)<0.02, f'Unexpected frame rate: {fps}'
    while True:
        ok,frame=capture.read()
        if not ok:break
        rgb=cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)
        assert rgb.shape==expected.shape, 'Video dimensions changed'
        error=float(np.abs(expected-rgb.astype(np.float32)).mean())
        # H.264 is lossy. This allows small codec rounding, not empty/wrong frames.
        assert error<=3, f'Decoded frame {len(errors)} differs: {error}'
        if not errors:Image.fromarray(rgb).save(out/'decoded-first-frame.png')
        errors.append(error)
finally:capture.release()
assert len(errors)==9, f'Expected nine decoded frames, found {len(errors)}'
assert hashlib.sha256(source.read_bytes()).hexdigest()==before
report={'ok':True,'dimensions':[160,120],'decodedFrames':len(errors),'fps':fps,
        'stillMeanAbsoluteError':still_error,'videoMeanAbsoluteErrors':errors,
        'originalPreserved':True}
(out/'result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
