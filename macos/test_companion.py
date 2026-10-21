"""Execute real Mac workers and GUI, preserving a machine-readable test record."""
import json,os,pathlib,signal,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parent;BUILD=ROOT/'build';QA=ROOT/'checks/companion';QA.mkdir(parents=True,exist_ok=True)
APP=BUILD/'AE Studio/AE Studio.app';D=APP/'Contents/Resources/app';PY=D/'pdf/runtime/python/bin/python3'
checks=[]
def test(name,args,env=None,timeout=900):
    try:
        p=subprocess.run([str(a) for a in args],capture_output=True,text=True,timeout=timeout,env=env)
        (QA/(name+'.log')).write_text(p.stdout+'\n'+p.stderr)
        checks.append({'name':name,'ok':p.returncode==0,'exit':p.returncode})
    except Exception as e:checks.append({'name':name,'ok':False,'error':str(e)})
    (QA/'result.json').write_text(json.dumps({'ok':all(c['ok'] for c in checks),'checks':checks},indent=2))
    print(name,checks[-1],flush=True)
test('pdf-engine',[PY,D/'pdf/test_engine.py'])
test('archive-signatures',[PY,D/'pdf/archive_test.py'])
test('language-ocr-translation',[D/'pdf/runtime/language/python/bin/python3',D/'pdf/language_test.py'],timeout=1200)
import shutil
if (D/'pdf/language-fixtures').exists():shutil.copytree(D/'pdf/language-fixtures',QA/'language-previews',dirs_exist_ok=True)
if (D/'pdf/language-test-report.json').exists():shutil.copy2(D/'pdf/language-test-report.json',QA/'language-test-report.json')
test('hangul-start',[D/'hangul-runtime/hwp','--version'])
test('avif-conversion',[PY,ROOT/'test_avif.py',D,QA/'avif'])
fixtures=[ROOT/'checks/exports/outputs 한글'/name for name in ['document.docx','document.pdf','sheet.xlsx','slides.pptx']]
fixtures.append(QA/'avif/image 한글.avif')
env={**os.environ,'STUDIO_TEST_MAC':'1','STUDIO_TEST_OUTPUT':str(QA/'gui'),'UNIFIED_STUDIO_DATA':str(QA/'profile'),'AE_MAC_FIXTURES':json.dumps([str(p) for p in fixtures])}
test('desktop-gui',[APP/'Contents/MacOS/Electron','--studio-test'],env=env,timeout=360)
test('hangul-conversion',['node',ROOT/'test_hangul.cjs',D,ROOT/'fixtures',QA/'hangul'],timeout=180)
test('google-helper-status',['node',ROOT/'test_google.cjs',D,QA/'google-helper'],timeout=600)
# Keep later installed-app checks from accidentally reusing a build-tree editor.
for line in subprocess.check_output(['ps','-axo','pid=,comm='],text=True).splitlines():
    fields=line.strip().split(None,1)
    if len(fields)==2 and fields[1].startswith(str(BUILD/'AE Studio/Apps')+'/'):
        try:os.kill(int(fields[0]),signal.SIGTERM)
        except ProcessLookupError:pass
raise SystemExit(0 if all(c['ok'] for c in checks) else 1)
