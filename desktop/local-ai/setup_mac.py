"""Install only the verified bundled runtime and pinned optional image model."""
import hashlib,json,os,pathlib,shutil,sys,tarfile,tempfile,urllib.request
HERE=pathlib.Path(__file__).resolve().parent
def digest(file):
    with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def main():
    if sys.platform!='darwin':raise RuntimeError('This setup is for Apple-silicon Mac.')
    root=pathlib.Path.home()/'Library/Application Support/AE Studio';root.mkdir(parents=True,exist_ok=True)
    target=root/'Local AI'
    if target.exists():raise RuntimeError('A Local AI folder already exists. Keep it safe; move it aside before a fresh setup.')
    if shutil.disk_usage(root).free<15*1024**3:raise RuntimeError('Free at least 15 GB for local AI setup.')
    pin=json.loads((HERE/'mac-setup.json').read_text());archive=HERE/pin['runtime']['file']
    if digest(archive)!=pin['runtime']['sha256']:raise RuntimeError('Bundled runtime did not pass verification.')
    stage=pathlib.Path(tempfile.mkdtemp(prefix='AI-setup-',dir=root))
    try:
        print('Preparing the Mac image-generation runtime…',flush=True)
        with tarfile.open(archive) as t:t.extractall(stage,filter='data')
        model=pin['model'];dest=stage/'Local AI/models/checkpoints'/model['name'];dest.parent.mkdir(parents=True)
        print('Downloading the free SDXL model (6.9 GB)…',flush=True)
        req=urllib.request.Request(model['url'],headers={'User-Agent':'AE-Studio-Local-AI-Setup'})
        with urllib.request.urlopen(req,timeout=120) as response,dest.open('wb') as out:
            total=0;last=-1;checksum=hashlib.sha256()
            while chunk:=response.read(1024*1024):
                total+=len(chunk)
                if total>model['bytes']:raise RuntimeError('Model download exceeded its pinned size.')
                out.write(chunk);checksum.update(chunk);percent=total*100//model['bytes']
                if percent>=last+5:print(f'Downloading SDXL: {percent}%',flush=True);last=percent
        if total!=model['bytes'] or checksum.hexdigest()!=model['sha256']:raise RuntimeError('Model download failed its verification; no downloaded model was enabled.')
        if target.exists():raise RuntimeError('A Local AI folder appeared during setup; it was not replaced.')
        (stage/'Local AI').rename(target)
        print('Local AI installed. You can now start it.',flush=True)
    finally:
        if stage.resolve().parent==root.resolve() and stage.name.startswith('AI-setup-'):shutil.rmtree(stage)
if __name__=='__main__':main()
