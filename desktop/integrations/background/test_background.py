"""Local worker checks with an original synthetic shaded mannequin fixture."""
from pathlib import Path
import base64
import importlib.util
import io
import json
import struct
import subprocess
import sys
import unittest
import zlib

from PIL import Image
import numpy as np

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("studio_background_remove",HERE/"remove.py")
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
EVIDENCE=HERE/"qa"


def mannequin():
    """Original rendered ellipsoid sculpture, no third-party photo or upload."""
    size=768
    yy,xx=np.mgrid[0:size,0:size]
    background=np.stack([210+12*yy/size,224+8*yy/size,229+5*yy/size],axis=-1).astype(np.float32)
    ground_shadow=np.exp(-((xx-384)/170)**2-((yy-690)/25)**2)
    background-=ground_shadow[...,None]*40
    silhouette=np.zeros((size,size),dtype=bool)
    parts=[(340,555,42,140),(430,555,42,140),(275,370,38,118),(493,370,38,118),
           (384,375,96,148),(384,238,29,45),(384,158,66,80)]
    color=np.array([209,112,56],dtype=np.float32)
    for cx,cy,rx,ry in parts:
        dx=(xx-cx)/rx;dy=(yy-cy)/ry
        inside=dx*dx+dy*dy<=1
        z=np.sqrt(np.maximum(1-dx*dx-dy*dy,0))
        light=np.clip(.65+(-dx*.30-dy*.35+z*.45),.3,1.15)
        layer=np.clip(color*light[...,None],0,255)
        background[inside]=layer[inside];silhouette|=inside
    return Image.fromarray(np.clip(background,0,255).astype(np.uint8)),silhouette


def encoded(image):
    stream=io.BytesIO();image.save(stream,format="PNG")
    return base64.b64encode(stream.getvalue()).decode()


def png_header(width,height):
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''))+chunk(b'IEND',b'')


class BackgroundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        EVIDENCE.mkdir(exist_ok=True)
        cls.source,cls.truth=mannequin()
        cls.source.save(EVIDENCE/'original-synthetic-mannequin.png')
        command=[sys.executable,'-I','-B',str(HERE/'remove.py')]
        completed=subprocess.run(command,input=json.dumps({'imageBase64':encoded(cls.source)}).encode(),capture_output=True,timeout=180)
        cls.response=json.loads(completed.stdout)
        assert cls.response['ok'],cls.response
        cls.result=Image.open(io.BytesIO(base64.b64decode(cls.response['pngBase64']))).convert('RGBA')
        cls.result.save(EVIDENCE/'transparent-synthetic-mannequin.png')
        checker=Image.new('RGBA',cls.result.size)
        yy,xx=np.mgrid[:cls.result.height,:cls.result.width]
        shade=np.where(((xx//24+yy//24)%2)==0,245,210).astype(np.uint8)
        checker=Image.fromarray(np.stack([shade,shade,shade,np.full_like(shade,255)],axis=-1))
        checker.alpha_composite(cls.result);checker.convert('RGB').save(EVIDENCE/'checker-preview.png')

    def test_real_foreground_and_transparency(self):
        alpha=np.asarray(self.result.getchannel('A'))
        self.assertEqual(self.result.size,self.source.size)
        self.assertGreater(float(np.mean(alpha<5)),.35)
        self.assertGreater(float(np.mean(alpha>200)),.1)
        # Exclude thin edge bands; a meaningful central object must survive.
        self.assertGreater(float(np.mean(alpha[self.truth]>128)),.85)
        self.assertLess(float(np.mean(alpha[~self.truth]>128)),.08)
        (EVIDENCE/'metrics.json').write_text(json.dumps({'width':self.result.width,'height':self.result.height,
            'transparentFraction':float(np.mean(alpha<5)),'opaqueFraction':float(np.mean(alpha>200)),
            'foregroundRetainedFraction':float(np.mean(alpha[self.truth]>128)),
            'backgroundRetainedFraction':float(np.mean(alpha[~self.truth]>128))},indent=2))

    def test_existing_transparency_preserved(self):
        original=self.source.convert('RGBA');mask=Image.new('L',original.size,255)
        pixels=np.asarray(mask).copy();pixels[:100]=0;original.putalpha(Image.fromarray(pixels))
        response=worker.remove_background({'imageBase64':encoded(original)})
        result=Image.open(io.BytesIO(base64.b64decode(response['pngBase64'])))
        self.assertTrue(np.all(np.asarray(result.getchannel('A'))[:100]==0))

    def test_malformed_base64(self):
        with self.assertRaises(worker.ImageError) as e:worker.remove_background({'imageBase64':'%%%bad%%%'})
        self.assertEqual(e.exception.code,'INVALID_IMAGE')

    def test_arbitrary_paths_rejected(self):
        with self.assertRaises(worker.ImageError) as e:worker.remove_background({'imagePath':'C:/private.png'})
        self.assertEqual(e.exception.code,'INVALID_REQUEST')

    def test_decoded_bytes_limit_before_model(self):
        with self.assertRaises(worker.ImageError) as e:worker.remove_background({'imageBase64':'A'*(worker.MAX_BASE64+1)})
        self.assertEqual(e.exception.code,'INPUT_TOO_LARGE')

    def test_large_dimensions_before_decode(self):
        with self.assertRaises(worker.ImageError) as e:worker.remove_background({'imageBase64':base64.b64encode(png_header(6000,6000)).decode()})
        self.assertEqual(e.exception.code,'IMAGE_TOO_LARGE')

    def test_uniform_image_no_object(self):
        for color in ('white','red','black'):
            with self.subTest(color=color):
                with self.assertRaises(worker.ImageError) as e:worker.remove_background({'imageBase64':encoded(Image.new('RGB',(64,64),color))})
                self.assertEqual(e.exception.code,'NO_FOREGROUND')

    def test_invalid_cli_json(self):
        response=subprocess.run([sys.executable,'-I','-B',str(HERE/'remove.py')],input=b'{broken',capture_output=True,timeout=15)
        parsed=json.loads(response.stdout)
        self.assertFalse(parsed['ok']);self.assertEqual(parsed['error']['code'],'INVALID_REQUEST')


if __name__=='__main__':unittest.main(verbosity=2)
