'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const pdf=require('./pdf/bridge.cjs');
const {createAIProvider}=require('./integrations/ai-provider.cjs');
const {createComfyManager}=require('./integrations/comfy-manager.cjs');
const {assertLocalPath}=require('./file-routing.cjs');

function installNativeTools({ipcMain,dialog,shell,win,views,dataDir,getSaveFolder,openFiles,openArtcraftImage,onExport,testDir,testMode=false}){
  const selected=new Map(),results=new Map();let order=[],signature=null,certificate=null,trustCertificates=[],controller=null;
  const trusted=(event,id)=>{const view=views.get(id);if(!view||event.sender!==view.webContents||event.senderFrame!==view.webContents.mainFrame||event.senderFrame.url!==`studio://${id}/index.html`)throw Error('Untrusted tool request');};
  const handle=(method,id,fn)=>ipcMain.handle('tools:'+method,(event,...args)=>{trusted(event,id);return fn(...args);});
  const selection=()=>({files:order.map(id=>{const f=selected.get(id);return {id,name:f.name,bytes:f.bytes};}),signature:signature?{name:signature.name}:null,certificate:certificate?{name:certificate.name}:null,trustCertificates:trustCertificates.map(f=>({name:f.name}))});
  function addFile(file){file=assertLocalPath(file);const actual=assertLocalPath(fs.realpathSync(file));const stat=fs.statSync(actual),limit=path.extname(actual).toLowerCase()==='.pdf'?2*1024**3:256*1024**2;if(!stat.isFile()||stat.size<1||stat.size>limit)throw Error('Choose a nonempty PDF up to 2 GB or another input up to 256 MB.');return {id:randomUUID(),path:actual,name:path.basename(actual),bytes:stat.size};}
  function inputRecords(paths){if(!Array.isArray(paths)||paths.length<1||paths.length>50)throw Error('Choose between one and 50 files.');const incoming=paths.map(addFile);if(incoming.reduce((n,f)=>n+f.bytes,0)>4*1024**3)throw Error('Choose at most 4 GB of inputs at a time.');return incoming;}
  function register(items,owner){return items.map(item=>{const id=randomUUID(),record={id,path:item.path,name:item.name||item.filename,bytes:item.bytes,module:owner};results.set(id,record);onExport?.(record);return {id,name:record.name,bytes:record.bytes};});}
  handle('pdf-capabilities','pdf-tools',()=>pdf.capabilities());
  handle('pdf-selection','pdf-tools',selection);
  handle('pdf-pick','pdf-tools',async role=>{
    if(controller)throw Error('Wait for the current PDF operation to finish.');
    if(role==='clear-trust'){trustCertificates=[];return selection();}
    const pickers={
      inputs:{title:'Choose files for PDF Tools',multiple:true,extensions:['pdf','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','rtf','html','htm','png','jpg','jpeg','webp','bmp','tif','tiff']},
      signature:{title:'Choose a signature image',extensions:['png','jpg','jpeg']},
      certificate:{title:'Choose your signing certificate and private key',extensions:['p12','pfx']},
      trust:{title:'Choose certificates you trust for this verification',multiple:true,extensions:['pem','crt','cer']}
    };
    const picker=pickers[role];if(!picker)throw Error('Unknown selection.');
    const reply=await dialog.showOpenDialog(win,{title:picker.title,properties:picker.multiple?['openFile','multiSelections']:['openFile'],filters:[{name:picker.title,extensions:picker.extensions}]});
    if(!reply.canceled){
      const incoming=inputRecords(reply.filePaths);
      if(incoming.some(f=>f.bytes>256*1024**2)&&!testMode){const consent=await dialog.showMessageBox(win,{type:'warning',title:'Process large PDFs',message:'Continue with these large PDF files?',detail:'PDF Tools reads files locally and supports up to 2 GB per PDF, 4 GB total and 2,000 pages per document. OCR, conversion and rendering may require substantial memory and time. Originals stay unchanged.',buttons:['Cancel','Continue'],defaultId:0,cancelId:0});if(consent.response!==1)return selection();}
      if(incoming.some(file=>!picker.extensions.includes(path.extname(file.path).slice(1).toLowerCase())))throw Error('Choose the file type shown in the picker.');
      if(role==='signature')signature=incoming[0];
      else if(role==='certificate')certificate=incoming[0];
      else if(role==='trust')trustCertificates=incoming;
      else{selected.clear();order=[];for(const f of incoming){selected.set(f.id,f);order.push(f.id);}}
    }
    return selection();
  });
  handle('pdf-order','pdf-tools',ids=>{if(controller)throw Error('Wait for the current PDF operation.');if(!Array.isArray(ids)||ids.length>50||new Set(ids).size!==ids.length||ids.some(id=>!selected.has(id)))throw Error('Invalid file order.');order=ids;return selection();});
  handle('pdf-cancel','pdf-tools',()=>{controller?.abort();return {cancelled:!!controller};});
  handle('pdf-run','pdf-tools',async(action,options={})=>{
    if(controller)throw Error('A PDF operation is already running.');
    if(!pdf.actions.includes(action)||action==='capabilities')throw Error('Unknown PDF action.');
    if(!order.length)throw Error('Choose your input files first.');
    if(!options||typeof options!=='object'||Array.isArray(options)||JSON.stringify(options).length>1024*1024)throw Error('Invalid PDF options.');
    const many=['merge','images-to-pdf','scan-to-pdf','compare'].includes(action);
    const safe={...options,inputs:(many?order:order.slice(0,1)).map(id=>selected.get(id).path)};
    delete safe.outputDir;delete safe.signaturePath;delete safe.executable;delete safe.command;delete safe.candidateFile;delete safe.certificatePath;delete safe.trustCertificatePaths;
    if(action==='sign'){if(!signature)throw Error('Choose a signature image first.');safe.signaturePath=signature.path;}
    if(action==='certificate-sign'){if(!certificate)throw Error('Choose your .p12 or .pfx signing certificate first.');safe.certificatePath=certificate.path;}
    if(action==='verify-signature')safe.trustCertificatePaths=trustCertificates.map(file=>file.path);
    if(!['inspect','preview'].includes(action)){
      let folder=testMode?testDir:getSaveFolder();
      if(!folder||!fs.existsSync(folder)){const r=await dialog.showOpenDialog(win,{title:'Choose where to save the new results',properties:['openDirectory','createDirectory']});if(r.canceled)return {ok:false,outputs:[],error:{code:'CANCELLED',message:'Saving cancelled.'}};folder=r.filePaths[0];}
      fs.mkdirSync(folder,{recursive:true});safe.outputDir=folder;
    }
    controller=new AbortController();
    try{
      const reply=await pdf.run(action,safe,{signal:controller.signal});
      if(reply.ok&&reply.outputs?.length){for(const item of reply.outputs){const relative=path.relative(safe.outputDir,item.path);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('The PDF engine returned an invalid result.');}reply.outputs=register(reply.outputs,'pdf-tools');}
      return reply;
    }finally{controller=null;safe.password='';safe.newPassword='';safe.ownerPassword='';safe.certificatePassword='';safe.passwords=[];safe.candidates=[];}
  });
  const localAI=createComfyManager({dataDir});
  const ai=createAIProvider({dataDir,getLocalConnection:()=>localAI.getConnection(),approveRun:async request=>{
    if(request.provider==='comfyui'&&request.localMode==='bundled')return true;
    if(testMode)return false;
    const local=request.provider==='comfyui';
    const detail=`Provider: ${request.provider}\nModel: ${request.model}\nType: ${request.kind} · one result${request.durationSeconds?` · ${request.durationSeconds} seconds`:''}\n${request.cost?.description||'An exact hosted price is not available.'}\n\nPrompt: ${String(request.prompt||'').slice(0,600)}\nReferences: ${request.referenceCount||0}`;
    const reply=await dialog.showMessageBox(win,{type:'question',title:local?'Run local generation?':'Approve a paid ArtCraft request?',message:local?'Generate on your local ComfyUI server?':'This generation may spend ArtCraft credits.',detail:detail+(local?'\n\nThis uses your computer and installed model.':'\n\nYour prompt and any reference URLs will be sent to ArtCraft. Continue only if you approve this potentially paid request.'),buttons:['Cancel',local?'Generate locally':'Approve this request'],defaultId:0,cancelId:0});
    return reply.response===1;
  }});
  for(const [method,fn] of Object.entries({status:()=>ai.status(),configure:x=>ai.configure(x),connection:()=>ai.connection(),models:x=>ai.models(x),estimate:x=>ai.estimate(x),generate:x=>{localAI.resetProgress();return ai.generate(x);},jobs:()=>ai.jobs(),poll:x=>ai.poll(x),import:async id=>({ok:true,outputs:register(await ai.importResult(id),'ai-studio')}),
    'local-status':()=>{const state=localAI.status();if(['failed','stopped'].includes(state.state))ai.endLocalJobs();return state;},
    'local-start':async options=>{if(localAI.status().state!=='running')ai.endLocalJobs();const result=await localAI.start(options);ai.configure({provider:'comfyui',localMode:'bundled'});return result;},
    'local-stop':async()=>{await localAI.stop();ai.endLocalJobs();return localAI.status();},
    'local-cancel':async()=>{await localAI.cancel();ai.endLocalJobs();return {ok:true};},
    'local-log':()=>{if(fs.existsSync(localAI.logFile))shell.showItemInFolder(localAI.logFile);return {ok:true};}
  }))handle('ai-'+method,'ai-studio',fn);
  handle('ai-preview','ai-studio',id=>{const item=results.get(id);if(!item||item.module!=='ai-studio'||!/^\.(png|jpg|webp)$/i.test(path.extname(item.path)))throw Error('Choose a generated image.');const image=require('electron').nativeImage.createFromPath(item.path);if(image.isEmpty())throw Error('The image could not be previewed.');return image.resize({width:Math.min(1024,image.getSize().width)}).toDataURL();});
  handle('ai-save-copy','ai-studio',async id=>{const item=results.get(id);if(!item||item.module!=='ai-studio')throw Error('Unknown result.');const reply=await dialog.showSaveDialog(win,{title:'Save generated image',defaultPath:path.join(getSaveFolder()||path.dirname(item.path),item.name)});if(reply.canceled)return {cancelled:true};if(path.resolve(reply.filePath)!==path.resolve(item.path))await fs.promises.copyFile(item.path,reply.filePath);return {ok:true};});
  handle('ai-artcraft','ai-studio',id=>{const item=results.get(id);if(!item||item.module!=='ai-studio'||path.extname(item.path)!=='.png')throw Error('Choose a generated PNG image.');return openArtcraftImage(item.path);});
  ipcMain.handle('tools:result',(event,id,mode)=>{const owner=views.get('pdf-tools')?.webContents===event.sender?'pdf-tools':'ai-studio';trusted(event,owner);const item=results.get(id);if(!item||item.module!==owner)throw Error('Unknown result.');if(!fs.existsSync(item.path))throw Error('This result has been moved or removed.');if(mode==='open')return openFiles([item.path],'Tool result');if(mode==='reveal'){shell.showItemInFolder(item.path);return {ok:true};}throw Error('Unknown result action.');});
  return {selection,localAI,addPDFInputs:paths=>{if(controller)throw Error('A PDF operation is running.');const incoming=inputRecords(paths);selected.clear();order=[];for(const f of incoming){selected.set(f.id,f);order.push(f.id);}return selection();},cancel:()=>{controller?.abort();localAI.shutdown();}};
}
module.exports={installNativeTools};

