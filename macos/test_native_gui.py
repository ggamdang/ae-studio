"""Opt-in original app control-channel startup checks with scratch profiles only."""
import json, os, pathlib, socket, subprocess, time
ROOT=pathlib.Path(__file__).resolve().parent
QA=pathlib.Path(os.environ.get('AE_NATIVE_QA_DIR',str(ROOT/'checks/native-macos'))); QA.mkdir(parents=True,exist_ok=True)
apps=json.loads((ROOT/'apps.json').read_text(encoding='utf-8'))
index=json.loads((ROOT/'build/native-index.json').read_text())
if os.environ.get('AE_NATIVE_QA_APPS'):
    selected=os.environ['AE_NATIVE_QA_APPS'].split(',');apps=[a for a in apps if a['id'] in selected]
startup_timeout=int(os.environ.get('AE_NATIVE_QA_STARTUP','25'))
results=[]
for app in apps:
    ident=app['id']; profile=QA/ident; profile.mkdir(exist_ok=True)
    env=os.environ.copy()
    for suffix in ['CONFIG_DIR','PROFILE_DIR','DATA_DIR']:
        env[ident.upper()+'_'+suffix]=str(profile/'profile')
    env[ident.upper()+'_AUTOMATION_WRITE_ROOT']=str(profile)
    env['APPDATA']=str(profile/'roaming');env['LOCALAPPDATA']=str(profile/'local')
    for name in ['APPDATA','LOCALAPPDATA']:pathlib.Path(env[name]).mkdir(exist_ok=True)
    with socket.socket() as reserve:reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
    control=profile/'control.json'; token=profile/'control.token'
    args=[index[ident]['executable'],'--control',str(control) if ident=='pdfcraft' else str(port)]
    if ident=='photocraft':args+=['--control-token-file',str(token)]
    if ident=='lightcraft':args+=['--library',str(profile/'library')]
    result={'app':ident,'port':port,'ok':False}
    start=time.time()
    with (profile/'stdout.log').open('wb') as stdout,(profile/'stderr.log').open('wb') as stderr:
        p=subprocess.Popen(args,env=env,stdout=stdout,stderr=stderr,creationflags=0,cwd=profile)
        try:
            if ident=='pdfcraft':
                while not control.exists() and p.poll() is None and time.time()-start<startup_timeout:time.sleep(.25)
                if not control.exists():raise RuntimeError('No PDF control endpoint')
                cp=subprocess.run([index[ident]['cli'],'ui','--control',str(control),'ui.inspect'],env=env,capture_output=True,timeout=12,creationflags=0)
                (profile/'control-reply.log').write_bytes(cp.stdout+b'\nSTDERR\n'+cp.stderr)
                response=json.loads(cp.stdout.decode('utf-8'))
                result.update(ok=cp.returncode==0,response=response)
            else:
                sock=None
                while p.poll() is None and time.time()-start<startup_timeout:
                    try:sock=socket.create_connection(('127.0.0.1',port),timeout=.5);break
                    except OSError:time.sleep(.3)
                if sock is None:raise RuntimeError('Control port unavailable; process exit '+str(p.poll()))
                with sock:
                    sock.settimeout(12);stream=sock.makefile('rwb')
                    def request(value):
                        stream.write(json.dumps(value).encode()+b'\n');stream.flush();return json.loads(stream.readline(16*1024*1024))
                    auth={}
                    if ident=='photocraft':
                        reply=request({'id':'auth','method':'auth','params':{'token':token.read_text(encoding='utf-8').strip()}})
                        if not reply.get('ok'):raise RuntimeError('Photo auth failed')
                    if ident=='wordcraft':
                        keys=list((profile/'profile').glob('control-key.*'))
                        if not keys:raise RuntimeError('Word control key unavailable')
                        auth={'key':keys[0].read_text(encoding='utf-8').strip()}
                    response=request({'id':1,'method':'ui.inspect','params':{},**auth})
                    result.update(ok=response.get('ok')==True,response=response)
                    if result['ok']:
                        try:
                            shot=request({'id':2,'method':'ui.screenshot','params':{'path':str(profile/'window.png')},**auth})
                            # Do not retain inline image data in reports.
                            result['screenshotReply']={k:v for k,v in shot.items() if k!='result'}
                            result['screenshotFile']=(profile/'window.png').is_file()
                        except Exception as e:result['screenshotError']=str(e)
        except Exception as e:result['error']=str(e)
        finally:
            if p.poll() is None:p.terminate()
            try:p.wait(5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
    # No token or endpoint files are copied into release material.
    result['seconds']=round(time.time()-start,2);results.append(result)
    (QA/'result.json').write_text(json.dumps({'ok':all(r['ok'] for r in results),'checks':results},indent=2,ensure_ascii=False),encoding='utf-8')
    print(ident,'PASS' if result['ok'] else 'FAIL '+result.get('error',str(result.get('response'))),flush=True)

raise SystemExit(0 if all(r['ok'] for r in results) else 1)
