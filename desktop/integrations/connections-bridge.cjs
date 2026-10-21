'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createAccounts}=require('./accounts.cjs'),{createCloudServices,promptText}=require('./cloud-services.cjs'),{createPlanHelpers}=require('./plan-helpers.cjs');
const links=Object.freeze({privacy:'https://ggamdang.github.io/ae-studio/privacy.html',chatgpt:'https://chatgpt.com/#settings/Account',claude:'https://claude.ai/settings/usage',gemini:'https://antigravity.google/docs/ide/extensions',claudeInstall:'https://code.claude.com/docs/en/setup',googleSetup:'https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker',googlePermissions:'https://myaccount.google.com/permissions'});
function createConnections({dataDir,safeStorage,shell,dialog,win,getSaveFolder,openFiles,onDownload,testMode=false}){
  let accounts,cloud,initialError='',controller=null,busy=false;const helpers=createPlanHelpers({dataDir}),downloads=new Map();
  try{const configPath=path.join(__dirname,'google-desktop.json');const googleConfig=require('node:fs').existsSync(configPath)?JSON.parse(require('node:fs').readFileSync(configPath,'utf8')):null;accounts=createAccounts({dataDir,safeStorage,googleConfig,openExternal:url=>shell.openExternal(url)});cloud=createCloudServices({accounts,downloadRoot:path.join(dataDir,'Drive downloads'),onDownload});}catch(e){initialError=e.message;}
  function state(){return {oauth:accounts?.state()||{accounts:[],error:initialError,googleConfigured:false},helpers:helpers.state(),busy};}
  function cancel(){accounts?.cancel();helpers.cancel();controller?.abort();return state();}
  async function confirmPrompt(provider,model){
    if(testMode)throw Error('Live cloud generation is disabled in automated application tests.');
    const name={chatgpt:'ChatGPT',gemini:'Gemini via Google Antigravity',claude:'Claude'}[provider];
    const answer=await dialog.showMessageBox(win,{type:'question',title:'Send this prompt to '+name+'?',message:`Use ${name}${model?' · '+model:''} for this request?`,detail:provider==='gemini'?'Only the text you entered is sent. Your Google Antigravity allowance applies. Keep AI Credit Overages set to Never in your Google Antigravity settings to stay within free or included usage. AE Studio does not buy credits, enable overages, or fall back to a paid API. It cannot verify your remaining account allowance.':'Only the text you entered is sent. This uses your provider account. If you enabled extra usage or credits there, this request may spend them. AE Studio cannot verify your remaining allowance. Continue only if you approve that possibility for this request. No API-key fallback or automatic retry is used.',buttons:['Cancel','Send this request'],defaultId:0,cancelId:0});return answer.response===1;
  }
  async function action(operation,args={}){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid connection request.');
    if(operation==='state')return state();if(operation==='cancel')return cancel();
    if(operation==='link'){const url=links[args.id];if(!url)throw Error('Unknown provider help link.');await shell.openExternal(url);return {};}
    if(busy)throw Error('Wait for the current connection operation or cancel it.');busy=true;
    try{
      if(operation==='google-config'){
        if(!accounts)throw Error(initialError);const chosen=await dialog.showOpenDialog(win,{title:'Import AE Studio Google Desktop OAuth configuration',properties:['openFile'],filters:[{name:'Google app configuration',extensions:['json']}]});if(chosen.canceled)return state();
        const info=await fs.stat(chosen.filePaths[0]);if(info.size>65536)throw Error('This configuration is too large.');accounts.configureGoogle(JSON.parse(await fs.readFile(chosen.filePaths[0],'utf8')));return state();
      }
      if(operation==='gemini-install'){await helpers.geminiInstall();return state();}
      if(operation==='connect'){
        if(['chatgpt','google'].includes(args.provider)){if(!accounts)throw Error(initialError);await accounts.connect(args.provider,args.id,args.email,args.pickFiles===true);}
        else if(args.provider==='gemini')await helpers.geminiConnect();else if(args.provider==='claude')await helpers.claudeConnect();else throw Error('Unknown provider.');return state();
      }
      if(operation==='disconnect'){
        if(['gemini','claude'].includes(args.provider))await helpers.disconnect(args.provider);else{if(!accounts)throw Error(initialError);await accounts.disconnect(args.id);}return state();
      }
      if(operation==='models'){if(!cloud)throw Error(initialError);return cloud.models(args.id);}
      if(operation==='ask'){
        const prompt=promptText(args.prompt);if(!['chatgpt','claude','gemini'].includes(args.provider))throw Error('Choose an AI provider.');
        if(args.provider==='chatgpt'){if(!accounts)throw Error(initialError);accounts.account(args.id,'chatgpt');}
        if(!await confirmPrompt(args.provider,args.model))return {cancelled:true};controller=new AbortController();
        try{return {text:args.provider==='chatgpt'?await cloud.chatgpt(args.id,args.model,prompt,controller.signal):args.provider==='claude'?await helpers.claudeAsk(prompt):await helpers.geminiAsk(prompt)};}finally{controller=null;}
      }
      if(operation==='drive-list'){if(!cloud)throw Error(initialError);return cloud.driveList(args.id);}
      if(operation==='drive-upload'){
        if(!cloud)throw Error(initialError);accounts.account(args.id,'google');
        const chosen=await dialog.showOpenDialog(win,{title:'Upload a new copy to Google Drive',defaultPath:getSaveFolder(),properties:['openFile']});if(chosen.canceled)return {cancelled:true};
        const answer=await dialog.showMessageBox(win,{type:'question',title:'Upload to Google Drive',message:'Upload '+path.basename(chosen.filePaths[0])+'?',detail:'A new copy will be added to '+accounts.state().accounts.find(a=>a.id===args.id).label+'. No existing Drive file will be replaced. Your Google storage limit applies.',buttons:['Cancel','Upload new copy'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};
        controller=new AbortController();try{return await cloud.driveUpload(args.id,chosen.filePaths[0],controller.signal);}finally{controller=null;}
      }
      if(operation==='drive-download'){
        if(!cloud)throw Error(initialError);controller=new AbortController();try{const result=await cloud.driveDownload(args.id,args.fileId,controller.signal),id=require('node:crypto').randomUUID();downloads.set(id,result.path);return {id,name:result.name,bytes:result.bytes,converted:result.converted};}finally{controller=null;}
      }
      if(operation==='open-download'){const file=downloads.get(args.id);if(!file)throw Error('Download the file again before opening it.');return openFiles([file],'Google Drive downloaded copy');}
      throw Error('Unknown connection action.');
    }finally{busy=false;}
  }
  return {state,action,cancel};
}
module.exports={createConnections,links};
