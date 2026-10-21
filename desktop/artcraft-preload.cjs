'use strict';
const {contextBridge,ipcRenderer}=require('electron');
// ArtCraft's local adapters own file inputs and drops. Browser downloads flow
// through the host Save dialog; no filesystem or network bridge is exposed.
contextBridge.executeInMainWorld({func:()=>{
  for(const name of ['showSaveFilePicker','showOpenFilePicker']){
    Object.defineProperty(window,name,{value:undefined,configurable:true});
  }
}});
contextBridge.exposeInMainWorld('artcraftHost',Object.freeze({
  removeBackground:imageBase64=>ipcRenderer.invoke('studio:artcraft-remove-background',imageBase64)
}));
