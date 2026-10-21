const crypto=require('node:crypto');
const {validateFile}=require('./file-routing.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}finally{clearTimeout(timer);}}
function assertEditor(contents,id){
  if(contents.isDestroyed()||contents.isCrashed())throw new Error('The editor stopped. Close its workspace, reopen it, and try again.');
  const u=new URL(contents.getURL());
  if(u.protocol!=='studio:'||u.hostname!==id||u.pathname!=='/index.html')throw new Error('The editor is not on its trusted local page.');
}
async function ready(contents,id,timeoutMs=45000){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    assertEditor(contents,id);
    const r=await bounded(contents.executeJavaScript(`(()=>{const c=document.querySelector('canvas');const loaders=[...document.querySelectorAll('[id*=loading]')].filter(e=>getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden');return {canvas:!!c&&c.width>200&&c.height>200,loading:loaders.some(e=>e.getBoundingClientRect().height>1),fatal:!!window.filmcraftLoad?.fatal||!!window.filmcraftLoad?.error};})()`),Math.max(1,end-Date.now()),'The editor stopped responding while starting. Close its workspace and reopen it.');
    if(r.fatal)throw new Error('The editor reported a startup failure. Close its workspace and reopen it.');
    if(id==='artcraft'){
      const available=await bounded(contents.executeJavaScript("!!window.unifiedArtcraft?.ready && !!window.unifiedArtcraft?.importFile && !!document.querySelector('.local-toolbar')"),Math.max(1,end-Date.now()),'ArtCraft did not respond while starting.');
      if(available){await sleep(350);return;}
    }else if(r.canvas&&!r.loading){await sleep(350);return;}
    await sleep(250);
  }
  throw new Error('The editor did not finish starting. Close its workspace and try opening the file again.');
}
// The privileged debugger exists only in main and is attached for one import.
// No remote debugging port, renderer Node API, arbitrary command, or filesystem
// path is exposed to an editor. Chromium creates the File with its normal API.
async function importFile(contents,file,{timeoutMs=15000,artcraftImage=false}={}){
  assertEditor(contents,file.editor);
  const current=await validateFile(file.path,{allowLarge:true});
  const canvasImage=artcraftImage&&file.editor==='artcraft'&&file.action==='artcraft-import'&&current.extension==='png';
  if((current.editor!==file.editor&&!canvasImage)||current.size!==file.size||current.mtimeMs!==file.mtimeMs)throw new Error('This file changed while opening. Choose it again.');
  await ready(contents,file.editor);
  if(canvasImage){await contents.executeJavaScript("window.unifiedArtcraft.setTab('2D')");await sleep(100);}
  if(contents.debugger.isAttached())throw new Error('The editor is already being inspected. Close its developer tools and try again.');
  const bridge=contents.debugger;let attached=false,handler,timer,hiddenInput;
  try{
    bridge.attach('1.3');attached=true;
    await bridge.sendCommand('Page.enable');
    if(['film-import','film-project','artcraft-import'].includes(file.action)){
      // FilmCraft exposes an upstream browser-File API. A temporary file input
      // creates that File without reading bytes into or exposing paths in JS.
      hiddenInput='studio-import-'+crypto.randomUUID();
      await contents.executeJavaScript(`(()=>{const el=document.createElement('input');el.type='file';el.id=${JSON.stringify(hiddenInput)};el.hidden=true;document.body.append(el);})()`);
      const {root}=await bridge.sendCommand('DOM.getDocument');
      const {nodeId}=await bridge.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'#'+hiddenInput});
      assertEditor(contents,file.editor);
      await bridge.sendCommand('DOM.setFileInputFiles',{files:[file.path],nodeId});
      const invocation=file.action==='artcraft-import'?'window.unifiedArtcraft.importFile(input.files[0])':`window.filmcraft.${file.action==='film-project'?'openProject(input.files[0])':'importFiles(input.files)'}`;
      const result=await bounded(contents.executeJavaScript(`(async()=>{const input=document.getElementById(${JSON.stringify(hiddenInput)});if(!input?.files?.length)throw new Error('The import API is unavailable');return await ${invocation};})()`),file.large?600000:60000,'Import is taking longer than expected. The editor may still be processing; inspect it before retrying.');
      if(result?.ok===false||result?.error||result?.errors?.length||result?.failed?.length)throw new Error('The editor could not import this file: '+JSON.stringify(result).slice(0,400));
      if(file.action==='film-import'&&(!Array.isArray(result?.items)||!result.items.length))throw new Error('FilmCraft returned no imported media. Try a supported codec or convert a copy in the original application.');
    }else{
      await bridge.sendCommand('Page.setInterceptFileChooserDialog',{enabled:true});
      const delivered=new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('The editor did not request a file. Dismiss any Save changes dialog in the editor, then try Open again.')),timeoutMs);
        handler=async(_,method,params)=>{
          if(method!=='Page.fileChooserOpened')return;
          bridge.removeListener('message',handler);
          try{
            assertEditor(contents,file.editor);
            if(!params.backendNodeId)throw new Error('This editor did not expose a supported file input.');
            const {frameTree}=await bridge.sendCommand('Page.getFrameTree');
            if(params.frameId!==frameTree.frame.id)throw new Error('A nested page cannot receive this file.');
            const {node}=await bridge.sendCommand('DOM.describeNode',{backendNodeId:params.backendNodeId});
            const attrs=Object.fromEntries((node.attributes||[]).reduce((pairs,v,i,a)=>i%2===0?[...pairs,[v,a[i+1]]]:pairs,[]));
            if(node.nodeName!=='INPUT'||attrs.type?.toLowerCase()!=='file')throw new Error('The editor requested an invalid file input.');
            await bridge.sendCommand('DOM.setFileInputFiles',{files:[file.path],backendNodeId:params.backendNodeId});
            resolve();
          }catch(e){reject(e);}
        };
        bridge.on('message',handler);
      });
      contents.focus();
      if(file.action==='light-import'){
        // The published web API calls the original picker even if the user has
        // customized keyboard bindings; it still receives only a browser File.
        await bounded(contents.executeJavaScript(`window.lightcraft.command('file.addPhotos','{}')`,true),timeoutMs,'The photo library did not respond to its import command. Close its workspace and try again.');
      }else{
        contents.sendInputEvent({type:'keyDown',keyCode:'O',modifiers:['control']});
        contents.sendInputEvent({type:'keyUp',keyCode:'O',modifiers:['control']});
      }
      await delivered;
    }
    return {name:file.name,editor:file.editor,delivered:true};
  }finally{
    clearTimeout(timer);if(handler)bridge.removeListener('message',handler);
    if(hiddenInput&&!contents.isDestroyed())await bounded(contents.executeJavaScript(`document.getElementById(${JSON.stringify(hiddenInput)})?.remove()`),1500,'Import cleanup timed out.').catch(()=>{});
    if(attached&&bridge.isAttached()){
      await bridge.sendCommand('Page.setInterceptFileChooserDialog',{enabled:false}).catch(()=>{});
      bridge.detach();
    }
  }
}
module.exports={importFile,ready,assertEditor};
