const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('studio',Object.freeze({
  state:()=>ipcRenderer.invoke('studio:state'),
  appearance:patch=>ipcRenderer.invoke('studio:appearance',patch),
  formats:()=>ipcRenderer.invoke('studio:formats'),
  connections:(operation,args)=>ipcRenderer.invoke('studio:connections',operation,args),
  install:()=>ipcRenderer.invoke('studio:install'),
  open:(id)=>ipcRenderer.invoke('studio:open',id),
  openFiles:()=>ipcRenderer.invoke('studio:open-files'),
  dismissError:()=>ipcRenderer.invoke('studio:dismiss-error'),
  registrationHelp:()=>ipcRenderer.invoke('studio:registration-help'),
  windowsDefaults:()=>ipcRenderer.invoke('studio:windows-defaults'),
  userData:()=>ipcRenderer.invoke('studio:user-data'),
  installation:()=>ipcRenderer.invoke('studio:installation'),
  shellDialog:visible=>ipcRenderer.invoke('studio:shell-dialog',visible===true),
  home:()=>ipcRenderer.invoke('studio:home'),
  closeEditor:()=>ipcRenderer.invoke('studio:close-editor'),
  shortcut:(action)=>ipcRenderer.invoke('studio:shortcut',action),
  chooseFolder:()=>ipcRenderer.invoke('studio:folder'),
  revealExport:(id)=>ipcRenderer.invoke('studio:reveal',id),
  notices:()=>ipcRenderer.invoke('studio:notices'),
  onState:(callback)=>{const handler=(_,state)=>callback(state);ipcRenderer.on('studio:changed',handler);return()=>ipcRenderer.removeListener('studio:changed',handler);}
}));
// File paths are extracted inside the isolated preload, never returned to the
// page. Synthetic JS File objects have no filesystem path and are rejected.
window.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();},true);
window.addEventListener('drop',event=>{
  if(!event.isTrusted||!event.dataTransfer?.files.length)return;
  event.preventDefault();event.stopImmediatePropagation();
  const files=[...event.dataTransfer.files].map(file=>webUtils.getPathForFile(file)).filter(Boolean);
  if(files.length)ipcRenderer.invoke('studio:drop-files',files).catch(()=>{});
},true);
