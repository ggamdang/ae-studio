'use strict';
// Official provider helpers own their login. AE Studio never extracts their tokens.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {promptText}=require('./cloud-services.cjs');
const {cleanEnvironment}=require('./provider-environment.cjs');
function createPlanHelpers({dataDir,spawnImpl=spawn}){
  const root=path.join(dataDir,'AccountHelpers'),claudeHome=path.join(root,'Claude');let child=null,stopActive=null;
  const claudeCandidates=[path.join(os.homedir(),'.local','bin','claude.exe'),path.join(os.homedir(),'.local','bin','claude')];
  function claudePath(){return claudeCandidates.find(p=>fs.existsSync(p));}
  function state(){return {busy:!!child||antigravity.state().busy,gemini:antigravity.state(),claude:{installed:!!claudePath(),connected:fs.existsSync(path.join(claudeHome,'connected.json'))}};}
  function cancel(){stopActive?.();antigravity.cancel();}
  function environment(){return {...cleanEnvironment(),NO_COLOR:'1',CLAUDE_CONFIG_DIR:claudeHome,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'};}
  async function prepare(){const workspace=path.join(claudeHome,'workspace');await fsp.mkdir(workspace,{recursive:true});await fsp.writeFile(path.join(workspace,'.env'),'');return workspace;}
  function start(executable,args,cwd,env){if(child)throw Error('Finish or cancel the current provider operation first.');child=spawnImpl(executable,args,{cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});return child;}
  async function claudeRun(args,{input='',timeout=180000,acceptNonzero=false}={}){
    const executable=claudePath();if(!executable)throw Error('Install the official Claude Code helper first, then refresh connections.');
    const cwd=await prepare(),proc=start(executable,args,cwd,environment());
    return new Promise((resolve,reject)=>{let output='',length=0,finished=false;const done=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);if(child===proc)child=null;stopActive=null;error?reject(error):resolve(value);};
      const stop=()=>{proc.kill();done(Error('Claude operation cancelled.'));};stopActive=stop;const timer=setTimeout(stop,timeout);
      proc.on('error',()=>done(Error('The official Claude helper could not start.')));
      proc.stdout.setEncoding('utf8');proc.stdout.on('data',b=>{length+=Buffer.byteLength(b);if(length>4*1024**2){proc.kill();done(Error('Claude returned too much output.'));}else output+=b;});proc.stderr.on('data',()=>{});
      proc.on('close',code=>done(code===0||acceptNonzero?null:Error('Claude did not complete this operation. Check sign-in and plan usage; no paid API fallback was attempted.'),output));proc.stdin.on('error',()=>{});proc.stdin.end(input);
    });
  }
  async function claudeStatus(){const result=JSON.parse(await claudeRun(['auth','status','--json'],{acceptNonzero:true,timeout:20000}));return {loggedIn:result.loggedIn===true&&['claude.ai','oauth_token'].includes(result.authMethod),method:result.authMethod||'none'};}
  async function claudeConnect(){await claudeRun(['auth','login','--claudeai'],{timeout:1800000});const status=await claudeStatus();if(!status.loggedIn)throw Error('Claude subscription login was not confirmed. API-key logins are not accepted.');await fsp.writeFile(path.join(claudeHome,'connected.json'),'{}');return state();}
  async function claudeAsk(prompt){
    const input=promptText(prompt);if(!(await claudeStatus()).loggedIn)throw Error('Sign in to your Claude subscription first.');
    const raw=await claudeRun(['-p','--output-format','json','--tools','','--safe-mode','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--system-prompt','You are the AE Studio writing assistant. Answer using text. No file access or computer tools are available.'],{input,timeout:300000});
    const result=JSON.parse(raw);if(result.is_error||typeof result.result!=='string')throw Error('Claude did not complete the answer. Check your plan usage.');return result.result;
  }
  const antigravity=require('./antigravity.cjs').createAntigravity({dataDir,spawnImpl});
  const geminiProbe=()=>antigravity.probe(),geminiConnect=()=>antigravity.connect(),geminiAsk=prompt=>antigravity.ask(prompt),geminiInstall=()=>antigravity.install();
  async function disconnect(provider){if(!['gemini','claude'].includes(provider))throw Error('Unknown provider.');if(child)throw Error('Cancel the current provider operation first.');if(provider==='gemini'){await antigravity.disconnect();return state();}
    if(provider==='claude'&&claudePath())await claudeRun(['auth','logout'],{acceptNonzero:true,timeout:20000});
    const folder=claudeHome;if(fs.existsSync(folder)){const real=await fsp.realpath(folder),parent=await fsp.realpath(root);if(path.dirname(real)!==parent)throw Error('Account folder location could not be verified.');await fsp.rm(real,{recursive:true,force:true});}return state();
  }
  return {state,cancel,claudeConnect,claudeAsk,geminiConnect,geminiAsk,geminiProbe,geminiInstall,disconnect};
}
module.exports={createPlanHelpers,cleanEnvironment};
