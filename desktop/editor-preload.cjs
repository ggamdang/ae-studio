const {contextBridge,ipcRenderer,webUtils}=require('electron');
// Use the editors' published browser-download fallback so all saves flow through
// Unified Studio's native Save dialog, export folder, and recent-export history.
// No editor source or downloaded artifact is changed and no Node API is exposed.
contextBridge.executeInMainWorld({func:()=>{
  for(const name of ['showSaveFilePicker','showOpenFilePicker']){
    Object.defineProperty(window,name,{value:undefined,configurable:true});
  }
}});
// Physical drops anywhere in an editor use the same validated global routing.
// Internal synthetic drops used by main's bounded import bridge pass through.
window.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();},true);
window.addEventListener('drop',event=>{
  if(!event.isTrusted||!event.dataTransfer?.files.length)return;
  event.preventDefault();event.stopImmediatePropagation();
  const paths=[...event.dataTransfer.files].map(file=>webUtils.getPathForFile(file)).filter(Boolean);
  if(paths.length)ipcRenderer.invoke('studio:drop-files',paths).catch(()=>{});
},true);
