"""Test the actual installed app, LaunchServices registration and mounted files."""
import hashlib,json,os,pathlib,plistlib,shutil,signal,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent;QA=ROOT/'checks/installed';QA.mkdir(parents=True,exist_ok=True)
APP=pathlib.Path('/Applications/AE Studio/AE Studio.app');d=APP/'Contents/Resources/app'
info=plistlib.loads((APP/'Contents/Info.plist').read_bytes())
declared=set(info['CFBundleDocumentTypes'][0]['CFBundleTypeExtensions'])
catalog=json.loads((d/'native-apps.json').read_text())
required=set(e for m in catalog for e in m['extensions'])|{'hwp','hwpx','artcraft','glb'}
assert required<=declared,sorted(required-declared)
registry='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
registered=subprocess.check_output([registry,'-dump'],text=True)
assert 'com.aeeducation.aestudio' in registered,'Installed AE Studio must be registered by Installer'
image=QA/'test-files.dmg';src=QA/'volume-source';src.mkdir()
shutil.copy2(ROOT/'checks/exports/outputs 한글/document.docx',src/'Mounted 한글 document.docx')
subprocess.run(['hdiutil','create','-srcfolder',str(src),'-volname','AE Studio test 한글','-format','UDRW',str(image)],check=True,capture_output=True)
mount=QA/'mounted-volume';mount.mkdir()
try:
    subprocess.run(['hdiutil','attach','-nobrowse','-mountpoint',str(mount),str(image)],check=True,capture_output=True)
    file=mount/'Mounted 한글 document.docx';before=hashlib.sha256(file.read_bytes()).hexdigest()
    env={**os.environ,'STUDIO_TEST_MAC':'1','STUDIO_TEST_OUTPUT':str(QA/'gui'),'UNIFIED_STUDIO_DATA':str(QA/'profile'),'AE_MAC_FIXTURES':json.dumps([str(file)])}
    p=subprocess.run([str(APP/'Contents/MacOS/Electron'),'--studio-test'],env=env,text=True,capture_output=True,timeout=180)
    (QA/'app.log').write_text(p.stdout+'\n'+p.stderr)
    assert p.returncode==0,'Installed GUI/Finder test failed; inspect installed/gui/result.json'
    assert hashlib.sha256(file.read_bytes()).hexdigest()==before
    report={'ok':True,'registeredExtensions':len(declared),'sourceBytesPreserved':True,'installedGUI':True,'mountedVolume':True,'FinderDelivery':True,'realSMBShareTested':False}
    (QA/'result.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
finally:
    # Close only editor processes belonging to this disposable test installation.
    for line in subprocess.check_output(['ps','-axo','pid=,comm='],text=True).splitlines():
        fields=line.strip().split(None,1)
        if len(fields)==2 and fields[1].startswith('/Applications/AE Studio/Apps/'):
            try:os.kill(int(fields[0]),signal.SIGTERM)
            except ProcessLookupError:pass
    time.sleep(1)
    subprocess.run(['hdiutil','detach',str(mount)],check=True,capture_output=True)
