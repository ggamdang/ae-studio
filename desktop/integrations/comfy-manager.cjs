'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn,execFile}=require('node:child_process');
const {randomBytes,randomUUID}=require('node:crypto');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const MODEL='sd_xl_base_1.0.safetensors';
async function freePort(){const server=net.createServer();return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});}
function createComfyManager({dataDir,bundleRoot=require('../runtime-paths.cjs').localAI}={}){
  const python=path.join(bundleRoot,'runtime',process.platform==='darwin'?'python/bin/python3':'ComfyUI_windows_portable/python_embeded/python.exe');
  const model=path.join(bundleRoot,'models','checkpoints',MODEL);
  const root=path.join(dataDir,'local-ai');
  const acceptance=path.join(root,'sdxl-license-accepted.json');
  let child=null,starting=null,stopping=null,state='stopped',message='Ready to start. The model is included.',connection=null,hardware=null,progress=null,mode='auto';
  const available=()=>fs.existsSync(python)&&fs.existsSync(model)&&fs.statSync(model).size===6938078334;
  function status(){return {available:available(),state,message,mode,hardware,progress,model:MODEL,ramGB:Math.round(os.totalmem()/1073741824),providerFees:0,licenseAccepted:fs.existsSync(acceptance)};}
  async function probe(){
    if(hardware)return hardware;
    if(!available())throw Error(process.platform==='darwin'?'Choose Set up free local AI in AI Studio first.':'Local AI is not installed or is incomplete. Install the separate AE Studio Local AI add-on into the same folder as AE Studio, or extract the full portable package.');
    const code="import json,torch; ok=torch.cuda.is_available(); print(json.dumps({'cuda':ok,'mps':torch.backends.mps.is_available(),'name':torch.cuda.get_device_name(0) if ok else ('Apple Silicon' if torch.backends.mps.is_available() else 'CPU'),'vramGB':round(torch.cuda.get_device_properties(0).total_memory/1073741824,1) if ok else 0,'torch':torch.__version__,'architectures':torch.cuda.get_arch_list() if ok else []}))";
    hardware=await new Promise((resolve,reject)=>execFile(python,['-I','-B','-c',code],{windowsHide:true,timeout:120000,maxBuffer:1024*1024},(error,stdout)=>{if(error)return reject(Error('The bundled AI runtime could not start. Re-extract the package; on older Windows PCs check the runtime troubleshooting guide.'));try{resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)));}catch{reject(Error('Could not inspect the local AI hardware.'));}}));
    return hardware;
  }
  function getConnection(){if(state!=='running'||!connection)throw Error('Start local AI first.');return {...connection};}
  async function start(options={}){
    if(!fs.existsSync(acceptance)){if(options.acceptLicense!==true)throw Error('Read and accept the SDXL model license before starting local AI.');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(acceptance,JSON.stringify({license:'CreativeML Open RAIL++-M July 26 2023',acceptedAt:new Date().toISOString()}));}
    if(stopping)await stopping;
    if(starting)return starting;
    if(state==='running')return status();
    mode=options.mode||'auto';if(!['auto','nvidia','apple','cpu'].includes(mode))throw Error('Choose automatic, Apple silicon, NVIDIA, or CPU mode.');
    state='starting';message='Checking your computer…';progress=null;
    starting=(async()=>{
      let launched;
      try{
        const device=await probe();const cpu=mode==='cpu'||(mode==='auto'&&!device.cuda&&!device.mps);
        if(mode==='apple'&&!device.mps)throw Error('Apple graphics acceleration is unavailable. Choose CPU mode.');
        if(mode==='nvidia'&&!device.cuda)throw Error('NVIDIA graphics acceleration is unavailable. Choose Automatic or CPU mode.');
        if(!cpu&&!device.cuda&&!device.mps)throw Error('Supported graphics acceleration was not found. Choose CPU mode.');
        if(os.totalmem()<12*1073741824)throw Error('This bundled SDXL model needs at least 12 GB of system memory; 16 GB or more is recommended.');
        mode=cpu?'cpu':device.mps?'apple':'nvidia';message=cpu?'Starting CPU mode. Image generation will be slow.':'Starting on '+device.name+'…';
        for(const name of ['output','input','temp','user','cache'])fs.mkdirSync(path.join(root,name),{recursive:true});
        const config=path.join(root,'models.json');fs.writeFileSync(config,JSON.stringify({unified_studio:{base_path:bundleRoot,checkpoints:'models/checkpoints'}}));
        const port=await freePort();const token=randomBytes(32).toString('hex'),session=randomUUID();
        const args=['-I','-B','-u',path.join(bundleRoot,'studio_comfy.py'),'--listen','127.0.0.1','--port',String(port),'--disable-auto-launch','--disable-all-custom-nodes','--offline','--disable-assets','--disable-metadata','--extra-model-paths-config',config,'--base-directory',root,'--user-directory',path.join(root,'user'),'--output-directory',path.join(root,'output'),'--input-directory',path.join(root,'input'),'--temp-directory',path.join(root,'temp'),'--database-url','sqlite:///:memory:','--preview-method','none','--disable-comfy-compiler',...(cpu?['--cpu']:device.mps?['--force-fp32']:['--reserve-vram','1'])];
        const env={...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',DO_NOT_TRACK:'1',HF_HOME:path.join(root,'cache'),TEMP:path.join(root,'temp'),TMP:path.join(root,'temp')};
        child=launched=spawn(python,args,{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let spawnError=null;launched.once('error',error=>{spawnError=error;});
        connection={baseUrl:`http://127.0.0.1:${port}`,token,session};
        const logFile=path.join(root,'latest.log');fs.writeFileSync(logFile,'Unified Studio bundled local AI\n');let logBytes=0;
        const log=chunk=>{if(child!==launched)return;const text=String(chunk).replaceAll(token,'[private]');if(logBytes<4*1024*1024){fs.appendFileSync(logFile,text);logBytes+=Buffer.byteLength(text);}for(const match of text.matchAll(/(\d+)%\|[^\r\n]*?\|\s*(\d+)\/(\d+)/g))progress={percent:Number(match[1]),step:Number(match[2]),steps:Number(match[3])};};
        launched.stdout.on('data',log);launched.stderr.on('data',log);
        launched.once('exit',(code)=>{if(child!==launched)return;child=null;connection=null;progress=null;if(state!=='stopping'){state='failed';message=`Local AI stopped (${code??'closed'}). Try CPU mode if GPU memory is full, or view the local AI log.`;}});
        launched.stdin.on('error',()=>{});launched.stdin.write(JSON.stringify({token,session,parentPid:process.pid})+'\n');
        const end=Date.now()+180000;
        while(Date.now()<end){
          if(spawnError)throw Error('Could not launch the bundled AI runtime: '+spawnError.message);
          if(child!==launched||state!=='starting')throw Error(message);
          try{const response=await fetch(connection.baseUrl+'/system_stats',{headers:{'X-Studio-Session':token},signal:AbortSignal.timeout(2000),redirect:'error'});if(response.ok&&response.headers.get('X-Studio-Instance')===session){await response.body?.cancel();state='running';message=cpu?'Ready · CPU mode (slow)':'Ready · '+device.name;return status();}await response.body?.cancel();}catch{}
          await delay(500);
        }
        throw Error('Local AI took too long to start. View the log, then try CPU mode or re-extract the package.');
      }catch(error){if(launched&&child===launched){child=null;launched.kill();}connection=null;state='failed';message=error.message;throw error;}
      finally{starting=null;}
    })();return starting;
  }
  async function stop(){
    if(stopping)return stopping;
    stopping=(async()=>{
      if(starting)await starting.catch(()=>{});
      state='stopping';message='Stopping local AI…';const owned=child;child=null;connection=null;progress=null;
      if(owned)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);owned.once('exit',()=>{clearTimeout(timer);resolve();});owned.stdin.destroy();owned.kill();});
      state='stopped';message='Local AI stopped. Your saved images are kept.';return status();
    })();try{return await stopping;}finally{stopping=null;}
  }
  function shutdown(){child?.stdin.destroy();child?.kill();child=null;connection=null;}
  async function cancel(){const c=getConnection();for(const [route,body] of [['/queue',{clear:true}],['/interrupt',{}]]){const r=await fetch(c.baseUrl+route,{method:'POST',headers:{'X-Studio-Session':c.token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});await r.body?.cancel();if(!r.ok)throw Error('Could not cancel the image. Use Stop local AI.');}progress=null;}
  return {status,probe,start,stop,shutdown,cancel,getConnection,resetProgress:()=>{progress=null;},logFile:path.join(root,'latest.log')};
}
module.exports={createComfyManager,MODEL};
