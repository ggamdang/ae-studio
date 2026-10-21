"""Bundle the Mac ComfyUI runtime; the optional SDXL model downloads on demand."""
import json,os,pathlib,secrets,shutil,socket,subprocess,tarfile,time,urllib.request
from build_companion import ROOT,BUILD,SUITE,LOCK,fetch,extract,make_python,run

def build():
    pins=json.loads((ROOT/'local-ai-lock.json').read_text())
    code=next(p for p in pins if p['name']=='ComfyUI-v0.40.0-source.zip')
    target=BUILD/'local-ai-addon';target.mkdir()
    extract(fetch(code),BUILD/'comfy-source')
    source=next((BUILD/'comfy-source').glob('ComfyUI-*'))
    shutil.copytree(source,target/'runtime/ComfyUI')
    py,_=make_python(fetch(LOCK['python']),target/'runtime',target/'runtime/ComfyUI')
    run([py,'-m','pip','install','--no-cache-dir','-r',source/'requirements.txt'],timeout=900)
    shutil.copy2(ROOT.parent/'desktop/local-ai/studio_comfy.py',target/'studio_comfy.py')
    # Actual CPU server startup and access-control check, without a model/prompt.
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    qa=ROOT/'checks/local-ai';qa.mkdir(parents=True,exist_ok=True)
    token=secrets.token_hex(32);session=secrets.token_hex(16)
    with (qa/'startup.log').open('w') as log:
        proc=subprocess.Popen([str(py),'-I','-B','-u',str(target/'studio_comfy.py'),'--cpu','--listen','127.0.0.1','--port',str(port),'--disable-auto-launch','--disable-all-custom-nodes','--offline','--disable-assets','--database-url','sqlite:///:memory:'],stdin=subprocess.PIPE,stdout=log,stderr=log,text=True)
        try:
            proc.stdin.write(json.dumps({'token':token,'session':session,'parentPid':os.getpid()})+'\n');proc.stdin.flush()
            end=time.monotonic()+150;stats=None
            while time.monotonic()<end and proc.poll() is None:
                try:
                    req=urllib.request.Request(f'http://127.0.0.1:{port}/system_stats',headers={'X-Studio-Session':token})
                    with urllib.request.urlopen(req,timeout=2) as response:
                        assert response.headers['X-Studio-Instance']==session;stats=json.load(response);break
                except OSError:time.sleep(.5)
            if not stats:raise RuntimeError('ComfyUI Mac server did not start; see checks/local-ai/startup.log')
            try:urllib.request.urlopen(f'http://127.0.0.1:{port}/system_stats',timeout=3);raise RuntimeError('Unauthenticated access was accepted')
            except urllib.error.HTTPError as e:assert e.code==403
            (qa/'result.json').write_text(json.dumps({'ok':True,'cpuServerStartup':True,'unauthenticatedRequestRejected':True,'modelGenerationTested':False,'stats':stats},indent=2))
        finally:
            proc.terminate()
            try:proc.wait(10)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
    licenses=target/'licenses';licenses.mkdir()
    for pin in pins:
        if pin['name'] in ['SDXL-LICENSE.md','SDXL-MODEL-CARD.md']:fetch(pin,licenses/pin['name'])
    shutil.copy2(source/'LICENSE',licenses/'ComfyUI-LICENSE')
    run([py,'-m','pip','freeze'],stdout=(licenses/'runtime-versions.txt').open('w'))
    destination=SUITE/'AE Studio.app/Contents/Resources/app/local-ai'
    destination.mkdir(exist_ok=True)
    archive=destination/'Mac-runtime.tar.gz'
    with tarfile.open(archive,'w:gz',compresslevel=1) as out:out.add(target,arcname='Local AI')
    import hashlib
    with archive.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
    model=next(p for p in pins if p['name']=='sd_xl_base_1.0.safetensors')
    (destination/'mac-setup.json').write_text(json.dumps({'runtime':{'file':archive.name,'sha256':digest},'model':model},indent=2))
    source_dir=SUITE/'Source/Local AI';source_dir.mkdir(parents=True)
    shutil.copy2(fetch(code),source_dir/code['name'])
    print('Optional local AI runtime bundled; SDXL downloads only after model-license acceptance.',flush=True)
if __name__=='__main__':build()
