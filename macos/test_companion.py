"""Execute real Mac workers and GUI, preserving a machine-readable test record."""
import json,os,pathlib,subprocess,sys
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
test('hangul-start',[D/'hangul-runtime/hwp','--version'])
env={**os.environ,'STUDIO_TEST_MAC':'1','STUDIO_TEST_OUTPUT':str(QA/'gui'),'UNIFIED_STUDIO_DATA':str(QA/'profile')}
test('desktop-gui',[APP/'Contents/MacOS/Electron','--studio-test'],env=env,timeout=240)
raise SystemExit(0 if all(c['ok'] for c in checks) else 1)
