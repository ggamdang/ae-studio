const {contextBridge,ipcRenderer,webUtils}=require('electron');
// The release chooses its backend through eframe, not ?webgl / ?cpu flags.
// Hide WebGPU only in this isolated editor to select its shipped WebGL backend.
// Worker GPU rendering is separately disabled by ?nogpuworkers in the host URL.
contextBridge.executeInMainWorld({func:()=>{
  Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});
  for(const name of ['showSaveFilePicker','showOpenFilePicker']){
    Object.defineProperty(window,name,{value:undefined,configurable:true});
  }
}});
// Physical file drops go to main's validated shared file-opening flow. Paths
// never enter the editor's page world; no renderer filesystem API is exposed.
window.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();},true);
window.addEventListener('drop',event=>{
  if(!event.isTrusted||!event.dataTransfer?.files.length)return;
  event.preventDefault();event.stopImmediatePropagation();
  const paths=[...event.dataTransfer.files].map(file=>webUtils.getPathForFile(file)).filter(Boolean);
  if(paths.length)ipcRenderer.invoke('studio:drop-files',paths).catch(()=>{});
},true);
