"""Download verified upstream Mac applications without modifying their bundles."""
import concurrent.futures, hashlib, json, pathlib, plistlib, shutil, subprocess, sys, tempfile, urllib.request, zipfile
ROOT=pathlib.Path(__file__).resolve().parent
BUILD=ROOT/'build'; BUILD.mkdir(exist_ok=True)
APPS=BUILD/'AE Studio'/'Apps'; APPS.mkdir(parents=True,exist_ok=True)
LOCK=json.loads((ROOT/'native-lock.json').read_text())

def download(pin):
    target=BUILD/pin['url'].rsplit('/',1)[1]
    if not target.exists():
        request=urllib.request.Request(pin['url'],headers={'User-Agent':'AE-Studio-build'})
        with urllib.request.urlopen(request,timeout=180) as src, target.open('wb') as dst: shutil.copyfileobj(src,dst)
    with target.open('rb') as stream: actual=hashlib.file_digest(stream,'sha256').hexdigest()
    if actual!=pin['sha256']:raise RuntimeError('Checksum mismatch: '+pin['id'])
    return pin,target

def stage(pin,archive):
    mount=pathlib.Path(tempfile.mkdtemp(prefix='ae-dmg-'))
    try:
        subprocess.run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',str(mount),str(archive)],check=True,stdout=subprocess.DEVNULL)
        bundles=list(mount.glob('*.app'))
        if len(bundles)!=1:raise RuntimeError('Unexpected app count: '+pin['id'])
        src=bundles[0]; target=APPS/src.name
        if target.exists():raise RuntimeError('Refusing to replace existing app: '+str(target))
        subprocess.run(['ditto',str(src),str(target)],check=True)
        info=plistlib.loads((target/'Contents/Info.plist').read_bytes())
        executable=target/'Contents/MacOS'/info['CFBundleExecutable']
        _, cli_archive=download({'id':pin['id']+'-cli',**pin['cli']})
        cli_dir=BUILD/'cli'/pin['id'];cli_dir.mkdir(parents=True,exist_ok=True)
        with zipfile.ZipFile(cli_archive) as z:
            for name in z.namelist():
                if not (cli_dir/name).resolve().is_relative_to(cli_dir.resolve()):raise RuntimeError('Unsafe CLI archive path')
            z.extractall(cli_dir)
        clis=list(cli_dir.rglob(pin['id']+'-cli'))
        if len(clis)!=1:raise RuntimeError('Missing native CLI: '+pin['id'])
        cli=clis[0];cli.chmod(0o755)
        signature=subprocess.run(['codesign','--verify','--deep','--strict',str(target)],capture_output=True,text=True)
        return pin['id'],{'bundle':str(target.resolve()),'bundleName':src.name,'executable':str(executable.resolve()),'cli':str(cli.resolve()),'identifier':info['CFBundleIdentifier'],'version':info.get('CFBundleShortVersionString'),'signatureValid':signature.returncode==0,'signatureDiagnostic':signature.stderr[:3000],'documentTypes':info.get('CFBundleDocumentTypes',[]),'importedTypes':info.get('UTImportedTypeDeclarations',[]),'exportedTypes':info.get('UTExportedTypeDeclarations',[])}
    finally:
        subprocess.run(['hdiutil','detach',str(mount)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        mount.rmdir()

if __name__=='__main__':
    if sys.platform!='darwin':raise SystemExit('Run this build on macOS.')
    index={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for pin,archive in pool.map(download,LOCK):
            key,value=stage(pin,archive);index[key]=value
            (BUILD/'native-index.json').write_text(json.dumps(index,indent=2))
            print(key,value['version'],value['cli'],flush=True)
    if len(index)!=13:raise SystemExit('Expected all 13 native editors.')
