const {contextBridge,ipcRenderer}=require('electron');
const call=(method,...args)=>ipcRenderer.invoke('tools:'+method,...args);
contextBridge.exposeInMainWorld('studioTools',Object.freeze({
  pdf:Object.freeze({capabilities:()=>call('pdf-capabilities'),selection:()=>call('pdf-selection'),pick:role=>call('pdf-pick',role),setOrder:ids=>call('pdf-order',ids),run:(action,options)=>call('pdf-run',action,options),cancel:()=>call('pdf-cancel')}),
  ai:Object.freeze({status:()=>call('ai-status'),configure:config=>call('ai-configure',config),connection:()=>call('ai-connection'),models:kind=>call('ai-models',kind),estimate:input=>call('ai-estimate',input),generate:input=>call('ai-generate',input),jobs:()=>call('ai-jobs'),poll:id=>call('ai-poll',id),importResult:id=>call('ai-import',id),localStatus:()=>call('ai-local-status'),installLocal:options=>call('ai-local-install',options),cancelInstall:()=>call('ai-local-install-cancel'),startLocal:options=>call('ai-local-start',options),stopLocal:()=>call('ai-local-stop'),cancelLocal:()=>call('ai-local-cancel'),showLocalLog:()=>call('ai-local-log'),preview:id=>call('ai-preview',id),saveCopy:id=>call('ai-save-copy',id),openArtcraft:id=>call('ai-artcraft',id)}),
  result:(id,mode)=>call('result',id,mode)
}));
