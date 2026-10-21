import hashlib,json,pathlib,subprocess,urllib.request,zipfile
import cv2,numpy as np
from PIL import Image
root=pathlib.Path('film-probe');root.mkdir()
pin=next(p for p in json.loads(pathlib.Path('macos/native-lock.json').read_text()) if p['id']=='filmcraft')['cli']
with urllib.request.urlopen(pin['url'],timeout=120) as response:binary=response.read()
assert hashlib.sha256(binary).hexdigest()==pin['sha256']
archive=root/'cli.zip';archive.write_bytes(binary)
with zipfile.ZipFile(archive) as z:z.extractall(root/'cli')
cli=next((root/'cli').rglob('filmcraft-cli'));cli.chmod(0o755)
expected=np.asarray([[(x%256,y%256,(x+y)%256) for x in range(160)] for y in range(120)],dtype=np.uint8)
source=root/'image.png';Image.fromarray(expected).convert('RGBA').save(source)
project=root/'film.fcproj';video=root/'film.mp4';still=root/'frame.png'
def run(args):subprocess.run([str(cli),'--data-dir',str(root/'profile'),*map(str,args)],check=True)
run(['--save-as',project,'import',source.resolve()])
run(['--project',project,'--save','exec','file.newSequence',json.dumps({'name':'Verified image clip','fromItem':1})])
run(['--project',project,'render','--seconds','0.1','--out',still,'--scale','1'])
run(['--project',project,'export',video,'--start','0','--end','0.3','--scale','1','--no-audio'])
results={'videoSHA256':hashlib.sha256(video.read_bytes()).hexdigest(),'videoBytes':video.stat().st_size,'decoders':[]}
for name,backend in [('automatic',cv2.CAP_ANY),('ffmpeg',cv2.CAP_FFMPEG),('avfoundation',cv2.CAP_AVFOUNDATION)]:
    capture=cv2.VideoCapture(str(video),backend);row={'requested':name,'opened':capture.isOpened()};results['decoders'].append(row)
    if capture.isOpened():
        row['backend']=capture.getBackendName();row['fps']=capture.get(cv2.CAP_PROP_FPS);errors=[]
        while True:
            ok,frame=capture.read()
            if not ok:break
            rgb=cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)
            if not errors:Image.fromarray(rgb).save(root/(name+'.png'))
            errors.append(float(np.abs(expected.astype(np.float32)-rgb.astype(np.float32)).mean()))
        row['errors']=errors;row['frames']=len(errors)
    capture.release()
(root/'result.json').write_text(json.dumps(results,indent=2));print(json.dumps(results),flush=True)
(root/'opencv-build.txt').write_text(cv2.getBuildInformation())
