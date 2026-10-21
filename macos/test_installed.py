"""Test the actual installed app, LaunchServices registration and mounted files."""
import hashlib,json,os,pathlib,plistlib,shutil,signal,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent;QA=ROOT/'checks/installed';QA.mkdir(parents=True,exist_ok=True)
APP=pathlib.Path('/Applications/AE Studio/AE Studio.app');d=APP/'Contents/Resources/app'
info=plistlib.loads((APP/'Contents/Info.plist').read_bytes())
declared=set(info['CFBundleDocumentTypes'][0]['CFBundleTypeExtensions'])
catalog=json.loads((d/'native-apps.json').read_text())
required=set(e for m in catalog for e in m['extensions'])|{'avif','hwp','hwpx','artcraft','glb'}
assert required<=declared,sorted(required-declared)
registry='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
registered=subprocess.check_output([registry,'-dump'],text=True)
assert 'com.aeeducation.aestudio' in registered,'Installed AE Studio must be registered by Installer'
assert str(APP) in registered,'Finder registration must point to the installed app, not the build copy'
for editor in catalog:
    assert str(APP.parent/'Apps'/editor['bundleName']) in registered,'Missing installed Open With choice: '+editor['name']
py=d/'pdf/runtime/python/bin/python3'
def worker(action,source,*,allowed_rejection=None,log_name=None,**options):
    payload={'action':action,'options':{'inputs':[str(source)],'outputDir':str(QA),**options}}
    completed=subprocess.run([str(py),'-I','-B',str(d/'pdf/engine.py')],input=json.dumps(payload),text=True,capture_output=True,timeout=300)
    (QA/((log_name or action)+'.log')).write_text(completed.stdout+'\n'+completed.stderr)
    result=json.loads(completed.stdout)
    if allowed_rejection and result.get('ok') is False:
        assert result.get('error',{}).get('code')==allowed_rejection,result
        assert result.get('outputs')==[],result
        return result
    assert completed.returncode==0 and result.get('ok'),result
    assert all(pathlib.Path(item['path']).is_file() for item in result['outputs'])
    return result
# Native runtimes must work after moving out of the build directory.
office=worker('office-to-pdf',ROOT/'checks/exports/outputs 한글/document.docx')
# Test successful relocated conversion independently of an upstream PDF's fonts.
archive_source=QA/'archival-source.pdf'
subprocess.run([str(py),'-I','-B','-c',
    "import pymupdf as f,sys;d=f.open();p=d.new_page(width=595,height=842);p.insert_text((60,80),'AE Studio installed archive test',fontsize=20);p.draw_rect(f.Rect(60,160,240,260),color=(0,.3,.6),fill=(.8,.9,1));d.save(sys.argv[1]);d.close()",
    str(archive_source)],check=True,timeout=30)
archived=worker('pdfa',archive_source,profile='2b')
assert archived['details']['conforms'],archived
archive_pdf=next(item['path'] for item in archived['outputs'] if item['path'].endswith('.pdf'))
subprocess.run([str(py),'-I','-B','-c',
    "import pymupdf as f,sys;d=f.open(sys.argv[1]);assert len(d)==1 and 'AE Studio installed archive test' in d[0].get_text()",
    archive_pdf],check=True,timeout=30)
# The pinned WordCraft sample exposed a font-width mismatch in LibreOffice's
# PDF/A candidate. A rejected candidate must never be labelled archival output.
# A future conforming conversion is also valid; the veraPDF gate stays strict.
word_pdf=ROOT/'checks/exports/outputs 한글/document.pdf'
word_hash=hashlib.sha256(word_pdf.read_bytes()).hexdigest()
word_archive=worker('pdfa',word_pdf,profile='2b',allowed_rejection='PDFA_NONCOMPLIANT',log_name='wordcraft-pdfa')
if word_archive.get('ok'):assert word_archive['details']['conforms'],word_archive
assert hashlib.sha256(word_pdf.read_bytes()).hexdigest()==word_hash
word_archive_status='validated' if word_archive.get('ok') else 'rejected_nonconformant_font_metrics'
translated=worker('translate',ROOT/'checks/companion/language-previews/english.pdf',sourceLanguage='en',targetLanguage='ko')
hangul=subprocess.run(['node',str(ROOT/'test_hangul.cjs'),str(d),str(ROOT/'fixtures'),str(QA/'hangul')],text=True,capture_output=True,timeout=180)
(QA/'hangul.log').write_text(hangul.stdout+'\n'+hangul.stderr)
assert hangul.returncode==0,'Installed HWP/HWPX converter failed'
image=QA/'test-files.dmg';src=QA/'volume-source';src.mkdir()
shutil.copy2(ROOT/'checks/exports/outputs 한글/document.docx',src/'Mounted 한글 document.docx')
subprocess.run(['hdiutil','create','-srcfolder',str(src),'-volname','AE Studio test 한글','-format','UDRW',str(image)],check=True,capture_output=True)
mount=QA/'mounted-volume';mount.mkdir()
try:
    subprocess.run(['hdiutil','attach','-nobrowse','-mountpoint',str(mount),str(image)],check=True,capture_output=True)
    file=mount/'Mounted 한글 document.docx';before=hashlib.sha256(file.read_bytes()).hexdigest()
    env={**os.environ,'STUDIO_TEST_MAC':'1','STUDIO_TEST_OUTPUT':str(QA/'gui'),'UNIFIED_STUDIO_DATA':str(QA/'profile'),'AE_MAC_FIXTURES':json.dumps([str(file)])}
    p=subprocess.run([str(APP/'Contents/MacOS/Electron'),'--studio-test'],env=env,text=True,capture_output=True,timeout=360)
    (QA/'app.log').write_text(p.stdout+'\n'+p.stderr)
    assert p.returncode==0,'Installed GUI/Finder test failed; inspect installed/gui/result.json'
    assert hashlib.sha256(file.read_bytes()).hexdigest()==before
    report={'ok':True,'registeredExtensions':len(declared),'sourceBytesPreserved':True,'installedGUI':True,'mountedVolume':True,'FinderDelivery':True,'installedOfficeConversion':True,'installedPDFA':True,'wordCraftPDFASample':word_archive_status,'installedTranslation':True,'installedHangul':True,'realSMBShareTested':False}
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
