'use strict';
// The official runtime owns OAuth. Never read, copy, or expose its credentials.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {unzip}=require('fflate'),{cleanEnvironment}=require('./provider-environment.cjs'),{promptText}=require('./cloud-services.cjs');
const WINDOWS_RELEASE=Object.freeze({version:'1.4.0',url:'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip',sha256:'d737aad2d6388e071bc907db415c129a256915d275f436e68f10dcdf6af896da',files:Object.freeze({'agy_acp_server.exe':'2aa1897144a60aaa1b8b54fc0595511ac6e6ce0cf2a7b3166cb1d0e4d4005ab8','localharness_external.exe':'a5170ff005636b5e3fedbcb0f61fa3204a2789c19ef38dfc424ec884a98e80f9'})});
const RELEASE=process.platform==='darwin'?Object.freeze(require('./antigravity-mac.json')):WINDOWS_RELEASE;
const SETTINGS=Object.freeze({auth:{type:'oauth-personal'}});
const SESSION_META=Object.freeze({antigravity:{enabledTools:[],systemPrompt:{append:'You are the AE Studio writing assistant. Answer with text only. You have no file, browser, terminal or computer tools. Use only text supplied in this conversation.'}}});
function digest(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function providerError(error){const message=String(error?.message||'');if(/quota|resource.exhausted|rate.limit/i.test(message))return Error('Google’s available quota is exhausted. Wait for it to refresh. AE Studio has not switched to a paid API or enabled credits.');if(/ineligible|not eligible|unsupported|license/i.test(message))return Error('Google has not enabled Antigravity for this account. Try an eligible personal Google account. No paid fallback was used.');return Error('Google could not finish this operation. Check the browser sign-in, connection and account availability, then try again. No paid API fallback was used.');}
function createAntigravity({dataDir,spawnImpl=spawn,fetchImpl=fetch}){
 const base=path.join(dataDir,'ProviderHelpers','Antigravity'),runtime=path.join(base,RELEASE.version),profile=path.join(dataDir,'AccountHelpers','Antigravity'),cwd=path.join(profile,'workspace');let active=null,issue='',installing=false,installAbort=null,preparation=null;
 const executable=path.join(runtime,process.platform==='darwin'?'agy_acp_server.par':'agy_acp_server.exe');
 function state(){return {installed:Object.keys(RELEASE.files).every(name=>fs.existsSync(path.join(runtime,name))),connected:!issue&&fs.existsSync(path.join(profile,'connected.json')),issue,busy:!!active||installing||!!preparation,version:RELEASE.version};}
 function cancel(){preparation?.abort();installAbort?.abort();active?.close();}
 async function verify(){for(const [name,hash]of Object.entries(RELEASE.files)){const file=path.join(runtime,name);if(digest(await fsp.readFile(file))!==hash)throw Error('The Google helper failed its integrity check. Reinstall it from Accounts & cloud.');}}
 async function install(){
  if(installing||active||preparation)throw Error('Finish the current Google operation first.');if(!((process.platform==='win32'&&process.arch==='x64')||(process.platform==='darwin'&&process.arch==='arm64')))throw Error('The Google helper supports Windows x64 and Apple-silicon Mac.');
  installing=true;installAbort=new AbortController();const stage=path.join(base,'setup-'+crypto.randomUUID());
  try{
   if(state().installed){try{await verify();return state();}catch{/* Replace corrupt optional runtime only after a fresh verified download. */}}
   const response=await fetchImpl(RELEASE.url,{redirect:'error',signal:AbortSignal.any([installAbort.signal,AbortSignal.timeout(600000)])});if(!response.ok){await response.body?.cancel();throw Error('The Google helper could not be downloaded. Check your connection and try again.');}
   const chunks=[];let length=0;for await(const bytes of response.body){length+=bytes.length;if(length>160*1024**2)throw Error('The Google helper download exceeded its expected size.');chunks.push(bytes);}const archive=Buffer.concat(chunks);
   if(digest(archive)!==RELEASE.sha256)throw Error('The Google helper download did not match the verified release. No downloaded program was run.');
   const files=await new Promise((resolve,reject)=>unzip(archive,{filter:entry=>Object.hasOwn(RELEASE.files,entry.name)},(error,result)=>error?reject(error):resolve(result)));
   if(installAbort.signal.aborted)throw Error('Google helper setup cancelled.');await fsp.mkdir(stage,{recursive:true});
   for(const [name,hash]of Object.entries(RELEASE.files)){if(!files[name]||digest(files[name])!==hash)throw Error('The extracted Google helper did not pass verification.');await fsp.writeFile(path.join(stage,name),files[name],{flag:'wx',mode:0o755});}
   // The version directory is immutable. Existing partial installs are never run.
   if(fs.existsSync(runtime)){const backup=runtime+'.incomplete-'+crypto.randomUUID();await fsp.rename(runtime,backup);}await fsp.rename(stage,runtime);return state();
  }finally{installing=false;installAbort=null;if(fs.existsSync(stage))await fsp.rm(stage,{recursive:true,force:true});}
 }
 async function client(){
  if(active||installing||preparation)throw Error('Finish or cancel the current Google operation first.');if(!state().installed)throw Error('Set up the free Google helper first.');preparation=new AbortController();const ready=preparation;try{await verify();
  await fsp.mkdir(cwd,{recursive:true});await fsp.mkdir(path.join(profile,'antigravity-acp'),{recursive:true});await fsp.writeFile(path.join(profile,'antigravity-acp','settings.json'),JSON.stringify(SETTINGS));
  if(ready.signal.aborted)throw Error('Google operation cancelled.');
  const env={...cleanEnvironment(),GEMINI_HOME:profile,ANTIGRAVITY_HARNESS_PATH:path.join(runtime,process.platform==='darwin'?'localharness_external':'localharness_external.exe'),NO_COLOR:'1'};
  const proc=spawnImpl(executable,[],{cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let sequence=0,buffer='',closed=false,total=0,onText=()=>{};
  function close(reason=Error('Google operation cancelled.')){if(closed)return;closed=true;for(const task of pending.values()){clearTimeout(task.timer);task.reject(reason);}pending.clear();if(proc.exitCode===null){if(process.platform==='win32'&&spawnImpl===spawn){const killer=spawn('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>proc.kill());}else proc.kill();}if(active?.proc===proc)active=null;}
  active={proc,close};proc.on('error',()=>close(Error('The Google helper could not start. Try reinstalling it.')));proc.on('close',()=>close(Error('The Google helper closed before finishing.')));proc.stderr.on('data',()=>{});proc.stdin.on('error',()=>{});
  function send(value){if(!closed)proc.stdin.write(JSON.stringify(value)+'\n');}
  proc.stdout.setEncoding('utf8');proc.stdout.on('data',chunk=>{try{total+=Buffer.byteLength(chunk);if(total>8*1024**2)throw Error('Google returned more data than this request allows.');buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const m=JSON.parse(line);
   if(m.method&&m.id!==undefined){if(m.method==='session/request_permission')send({jsonrpc:'2.0',id:m.id,result:{outcome:{outcome:'cancelled'}}});else send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'AE Studio does not expose files, terminals or tools.'}});}
   else if(m.method==='session/update'){const u=m.params?.update;if(u?.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text')onText(u.content.text);}
   else if(pending.has(m.id)){const task=pending.get(m.id);pending.delete(m.id);clearTimeout(task.timer);m.error?task.reject(providerError(m.error)):task.resolve(m.result);}
  }}catch{close(Error('The Google helper returned an invalid response.'));}});
  function call(method,params,timeout=90000){return new Promise((resolve,reject)=>{if(closed)return reject(Error('Google helper is closed.'));const id=++sequence,timer=setTimeout(()=>close(Error('Google did not respond in time. Start a fresh sign-in if its browser window expired.')),timeout);pending.set(id,{resolve,reject,timer});send({jsonrpc:'2.0',id,method,params});});}
  try{const init=await call('initialize',{protocolVersion:1,clientInfo:{name:'ae-studio',title:'AE Studio',version:'0.7.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});if(!init.authMethods?.some(m=>m.id==='oauth-personal'))throw Error('This Google helper does not offer personal account sign-in.');return {call,close,init,setText:fn=>{onText=fn;}};}catch(e){close();throw e;}
  }finally{preparation=null;}
 }
 async function probe(){const c=await client();try{return {agent:c.init.agentInfo,googleLogin:c.init.authMethods.some(m=>m.id==='oauth-personal')};}finally{c.close();}}
 async function connect(){issue='';const c=await client();try{await c.call('authenticate',{methodId:'oauth-personal'},360000);const session=await c.call('session/new',{cwd,mcpServers:[],_meta:SESSION_META});await fsp.writeFile(path.join(profile,'connected.json'),JSON.stringify({version:RELEASE.version,verifiedAt:new Date().toISOString()}));return {state:state(),models:session.models?.availableModels?.map(m=>({id:m.modelId,name:m.name}))||[]};}catch(e){issue=e.message;throw e;}finally{c.close();}}
 async function ask(prompt){const input=promptText(prompt);if(!state().connected)throw Error('Sign in with Google for the writing assistant first.');const c=await client();try{await c.call('authenticate',{methodId:'oauth-personal'},360000);const session=await c.call('session/new',{cwd,mcpServers:[],_meta:SESSION_META});let output='';c.setText(text=>{output+=text;});const result=await c.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:input}]},300000);if(result.stopReason!=='end_turn'||!output.trim())throw Error('Google did not return a complete text answer. No automatic paid fallback was made.');return output;}finally{c.close();}}
 async function disconnect(){if(active||installing||preparation)throw Error('Cancel the current Google operation first.');if(fs.existsSync(profile)){const real=await fsp.realpath(profile),parent=await fsp.realpath(path.dirname(profile));if(path.dirname(real)!==parent)throw Error('The Google account folder could not be verified.');await fsp.rm(real,{recursive:true,force:true});}issue='';return state();}
 return {state,install,probe,connect,ask,disconnect,cancel};
}
module.exports={createAntigravity,RELEASE,SETTINGS,SESSION_META,providerError,digest};
