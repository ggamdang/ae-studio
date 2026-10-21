const {app,BrowserWindow,WebContentsView,ipcMain,protocol,session,dialog,Menu,shell,safeStorage,nativeTheme}=require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {modules}=require('./catalog.cjs');
const {resolveAsset,validModule,safeFilename}=require('./core.cjs');
const {validateFile,validateBatch,fileArguments,dialogFilters,publicCapabilities,MAX_BATCH_BYTES}=require('./file-routing.cjs');
const {importFile}=require('./file-import.cjs');
const office=require('./office-convert.cjs');
const {installNativeTools}=require('./native-tools.cjs');
const ROOT=__dirname;
const macNative=process.platform==='darwin'?require('./mac-native.cjs'):null;
const appearance=require('./appearance.cjs');
let preferences=appearance.normalize();
const editorRoot=path.join(ROOT,'editors');
const testMode=process.argv.includes('--studio-test')||process.env.STUDIO_TEST_INSTALLER==='1';
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const testDir=process.env.STUDIO_TEST_OUTPUT||path.resolve(ROOT,'../verification');
const installation=require('./install-context.cjs').installContext({isPackaged:app.isPackaged,execPath:process.execPath,root:ROOT});
const dataDir=installation.dataDir;
app.setPath('userData',dataDir);
app.setName('AE Studio');
if(process.platform==='win32')app.setAppUserModelId('UnifiedStudio.Desktop');
if(!app.requestSingleInstanceLock())app.exit(0);
app.on('second-instance',(_,argv,cwd)=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}const paths=fileArguments(argv,{defaultApp:process.defaultApp,cwd});if(paths.length)queueFiles(paths,'Open with');});
protocol.registerSchemesAsPrivileged([{scheme:'studio',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true,allowServiceWorkers:true,codeCache:true}}]);
const locks=JSON.parse(fs.readFileSync(path.join(ROOT,'modules.lock.json'),'utf8'));
let win,active=null,quitting=false,saveFolder='',exportsList=[],error='';
let installing=false,setupMessage='';
let opening=false,openMessage='',openQueue=Promise.resolve(),queuedRequests=0,shellReady=false,shellDialog=false;
const pendingLaunch=[];
app.on('open-file',(event,filename)=>{event.preventDefault();queueFiles([filename],'Finder');});
app.on('activate',()=>{if(win&&!win.isDestroyed()){win.show();win.focus();}});
const editorFiles=new Map();
// Root integration may set this only when a real local converter is available.
// Contract: async(validatedLegacySource) -> absolute path to a new modern copy.
// Never overwrite the source. Keep the converted copy alive for editor reads.
let legacyConverter=office.available()?file=>['hwp','hwpx'].includes(file.extension)?require('./integrations/hangul-convert.cjs').convertHangul(file.path,path.join(dataDir,'Converted')):office.convertOffice(file.path,file.targetExtension,path.join(dataDir,'Converted')):null;
let nativeTools;
let backgroundTool;
let connections;
const views=new Map();
const failures=[];
const initializedSessions=new Set();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'};
function workspaceRoot(id){return id==='artcraft'?path.join(ROOT,'artcraft','renderer'):path.join(editorRoot,id);}
function publicState(){return {modules:modules.map(m=>({...m,version:m.nativeTool?app.getVersion():m.engineVersion||locks.find(l=>l.id===m.id)?.version,opened:views.has(m.id),currentFile:editorFiles.get(m.id)||'',installed:macNative?.native(m.id)?macNative.installed(m.id):!!m.nativeTool||fs.existsSync(path.join(workspaceRoot(m.id),'index.html'))})),active,error,opening,openMessage,fileCapabilities:{...publicCapabilities(),formats:macNative?macNative.catalog.map(m=>({name:m.name,extensions:m.extensions})):publicCapabilities().formats,legacyConversion:!!legacyConverter},installing,setupMessage,saveFolder,exports:exportsList.map(({id,name,module,when})=>({id,name,module,when})),version:app.getVersion(),preferences,resolvedTheme:nativeTheme.shouldUseDarkColors?'dark':'light'};}
function emit(){if(win&&!win.isDestroyed()){layout();win.webContents.send('studio:changed',publicState());}}
function persist(){fs.mkdirSync(dataDir,{recursive:true});fs.writeFileSync(path.join(dataDir,'workspace.json'),JSON.stringify({saveFolder,exports:exportsList.slice(0,40),preferences},null,2));}
function layout(){if(!win||win.isDestroyed())return;const [width,height]=win.getContentSize();for(const [id,view] of views){view.setBounds(appearance.geometry(preferences,width,height,!!error));view.setVisible(id===active&&!shellDialog);}}
function setAppearance(patch){if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Invalid appearance settings.');preferences=appearance.normalize({...preferences,...patch});nativeTheme.themeSource=preferences.theme;persist();emit();return publicState();}
function localSession(ses, allowedHost){
  if(initializedSessions.has(allowedHost))return;
  initializedSessions.add(allowedHost);
  ses.protocol.handle('studio',async request=>{
    const url=new URL(request.url);
    if(url.hostname!==allowedHost)return new Response('Forbidden',{status:403});
    const nativeTool=modules.find(m=>m.id===allowedHost)?.nativeTool;
    const root=allowedHost==='shell'?path.join(ROOT,'ui'):nativeTool?path.join(ROOT,'tools-ui',nativeTool):workspaceRoot(allowedHost);
    const bundledFont=allowedHost==='wordcraft'&&url.pathname==='/ae-studio-fonts/NanumGothic-Regular.ttf';
    const fontBootstrap=allowedHost==='wordcraft'&&url.pathname==='/ae-studio-fonts.js';
    const file=bundledFont?path.join(ROOT,'pdf/runtime/language/fonts/NanumGothic-Regular.ttf'):fontBootstrap?path.join(ROOT,'integrations/wordcraft-fonts.js'):resolveAsset(root,url.pathname);
    if(!file)return new Response('Forbidden',{status:403});
    try{
      let bytes=await fsp.readFile(file);
      if(allowedHost==='wordcraft'&&url.pathname==='/index.html'){
        bytes=Buffer.from(bytes.toString('utf8').replace('const wasm = await init(',"await import('/ae-studio-fonts.js');\nconst wasm = await init("));
      }
      const csp=allowedHost==='shell'||nativeTool?"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'":
        "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'";
      return new Response(bytes,{headers:{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Security-Policy':csp,'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'}});
    }catch{return new Response('File not found',{status:404});}
  });
  ses.webRequest.onBeforeRequest((details,callback)=>{
    let ok=false;try{const u=new URL(details.url);ok=(u.protocol==='studio:'&&u.hostname===allowedHost)||['blob:','data:','devtools:'].includes(u.protocol);}catch{}
    callback({cancel:!ok});
  });
  const permissions=['clipboard-sanitized-write','fullscreen','persistent-storage'];
  ses.setPermissionRequestHandler((_,permission,callback)=>callback(permissions.includes(permission)));
  ses.setPermissionCheckHandler((_,permission)=>permissions.includes(permission));
  ses.on('will-download',(_,item)=>{
    const name=safeFilename(item.getFilename());
    const folder=testMode?testDir:(saveFolder||app.getPath('documents'));
    if(testMode){fs.mkdirSync(folder,{recursive:true});item.setSavePath(path.join(folder,`${allowedHost}-${Date.now()}-${name}`));}
    else item.setSaveDialogOptions({title:'Save export',defaultPath:path.join(folder,name)});
    item.once('done',(_,state)=>{
      if(state==='completed'){
        exportsList.unshift({id:require('node:crypto').randomUUID(),name:path.basename(item.getSavePath()),path:item.getSavePath(),module:allowedHost,when:new Date().toISOString()});
        exportsList=exportsList.slice(0,40);persist();emit();
      }else if(state!=='cancelled'){error='The export did not finish. Please try saving again.';emit();}
    });
  });
}
function guard(contents,host){
  const allowed=url=>{try{const u=new URL(url);return u.protocol==='studio:'&&u.hostname===host;}catch{return false;}};
  contents.on('will-navigate',(event,url)=>{if(!allowed(url))event.preventDefault();});
  contents.on('will-redirect',(event,url)=>{if(!allowed(url))event.preventDefault();});
  contents.setWindowOpenHandler(()=>({action:'deny'}));
  contents.on('render-process-gone',(_,details)=>{error=`${host} stopped (${details.reason}). Close its workspace and reopen it. Unsaved work may be lost.`;failures.push({host,...details});emit();});
  contents.on('console-message',(event)=>{if(testMode&&event.level==='error')failures.push({host,message:event.message});});
}
async function openEditor(id){
  if(!validModule(id,modules))throw new Error('Unknown editor');
  const module=modules.find(m=>m.id===id);
  if(macNative?.native(id)){await macNative.launch(id);openMessage=module.name+' opened in its own window.';emit();return publicState();}
  if(module.available===false)throw new Error(module.description);
  if(!module.nativeTool&&!fs.existsSync(path.join(workspaceRoot(id),'index.html')))throw new Error(module.bundledWorkspace?'This workspace is missing. Re-extract the complete application package.':'Finish setup to download the editors first.');
  error='';active=id;
  if(views.has(id)&&(views.get(id).webContents.isDestroyed()||views.get(id).webContents.isCrashed())){
    const broken=views.get(id);win.contentView.removeChildView(broken);if(!broken.webContents.isDestroyed())broken.webContents.close();views.delete(id);editorFiles.delete(id);
  }
  if(!views.has(id)){
    const ses=session.fromPartition(`persist:studio-${id}`);localSession(ses,id);
    const preload=module.nativeTool?'native-tools-preload.cjs':id==='artcraft'?'artcraft-preload.cjs':id==='effectcraft'?'integrations/effectcraft-preload.cjs':'editor-preload.cjs';
    const view=new WebContentsView({webPreferences:{session:ses,preload:path.join(ROOT,preload),sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,backgroundThrottling:false,spellcheck:false}});
    views.set(id,view);win.contentView.addChildView(view);guard(view.webContents,id);layout();emit();
    try{await view.webContents.loadURL(`studio://${id}/index.html`+(id==='effectcraft'?'?nogpuworkers&frameworkers=1&nosw':''));}catch(e){win.contentView.removeChildView(view);if(!view.webContents.isDestroyed())view.webContents.close();views.delete(id);active=null;error='Could not load this editor. Close and reopen the workspace, or run setup again.';emit();throw new Error(error);}
  }
  layout();views.get(id).webContents.focus();emit();return publicState();
}
function home(){active=null;layout();emit();return publicState();}
function trusted(event){if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame?.url!=='studio://shell/index.html')throw new Error('Untrusted request');}
function trustedDrop(event){
  if(win&&event.sender===win.webContents){trusted(event);return;}
  for(const [id,view] of views){
    if(event.sender!==view.webContents||event.senderFrame!==view.webContents.mainFrame)continue;
    let url;try{url=new URL(event.senderFrame.url);}catch{continue;}
    if(url.protocol==='studio:'&&url.hostname===id&&url.pathname==='/index.html')return;
  }
  throw new Error('Untrusted file drop');
}
async function openFiles(paths,source='Open'){
  const results=[];const problems=[];let total=0;
  opening=true;error='';openMessage='Preparing files…';emit();
  try{
    const files=validateBatch(paths);
    // Validate the complete batch before giving any editor a file.
    const prepared=[];
    for(const p of files){try{
      if(macNative?.route(p)){const result=await macNative.openFile(p,dataDir);results.push(result);openMessage='Opened '+result.name+' in '+result.editor;continue;}
      let file=await validateFile(p,{allowLegacy:typeof legacyConverter==='function',allowLarge:true});
      if(file.large&&!testMode){
        const answer=await dialog.showMessageBox(win,{type:'warning',title:'Open a large file',message:`Open ${file.name} (${(file.size/1024**2).toFixed(0)} MB)?`,detail:file.nativePDF?'This large PDF will open in PDF Tools for page preview, splitting, extraction and other local operations. The editable PDF canvas has a smaller memory limit. PDF Tools accepts up to 2 GB and 2,000 pages; complex operations can still need substantial memory.':file.streaming?'Video reads portions of the file as needed. Importing and seeking may take longer. Keep the original file available while editing.':'This editor loads the document into memory. Complex pages, layers or cells can need much more memory than the file size. Save other work before continuing. Larger opening is experimental.',buttons:['Cancel','Open large file'],defaultId:0,cancelId:0});
        if(answer.response!==1){results.push({name:file.name,cancelled:true});continue;}
      }
      if(file.extension==='avif'){file=await validateFile(await require('./integrations/raster-convert.cjs').convertRaster(file,path.join(dataDir,'Converted')));}
      if(file.code==='LEGACY_CONVERSION'){
        openMessage=`Converting ${file.name} to a new .${file.targetExtension} copy…`;emit();
        const converted=await validateFile(await legacyConverter(file),{allowLarge:true});
        if(converted.extension!==file.targetExtension)throw new Error('The converter did not produce the expected modern Office format.');
        file={...converted,convertedFrom:file.extension};
      }
      if(!file.streaming&&!file.nativePDF)total+=file.size;if(total>Math.max(MAX_BATCH_BYTES,Math.min(2*1024**3,require('node:os').totalmem()/8)))throw new Error('These documents together need too much memory. Open fewer files at once.');prepared.push(file);
    }catch(e){problems.push(e.message);}}
    for(const file of prepared){
      try{
        if(views.has(file.editor)&&!views.get(file.editor).webContents.isCrashed()&&!testMode){
          const answer=await dialog.showMessageBox(win,{type:'question',title:'Open another file',message:`Open ${file.name} in ${modules.find(m=>m.id===file.editor).name}?`,detail:'This editor already has work open. Save or export it first; importing another file may replace the current document. Other editors will remain open.',buttons:['Keep current work','Open file'],defaultId:0,cancelId:0});
          if(answer.response!==1){results.push({name:file.name,editor:file.editor,cancelled:true});continue;}
        }
        openMessage=`Opening ${file.name}…`;emit();
        const refreshPDF=file.nativePDF&&views.has('pdf-tools');
        if(file.nativePDF)nativeTools.addPDFInputs([file.path]);
        await openEditor(file.editor);
        const result=file.nativePDF?{name:file.name,editor:'pdf-tools',delivered:true}:await importFile(views.get(file.editor).webContents,file);
        if(refreshPDF)await views.get('pdf-tools').webContents.executeJavaScript('window.dispatchEvent(new Event("ae-pdf-selection"))');
        editorFiles.set(file.editor,file.name);results.push(result);
        openMessage=`Sent ${file.name} to ${modules.find(m=>m.id===file.editor).name}. ${file.convertedFrom?`Imported from .${file.convertedFrom} as a new .${file.extension} copy; the original stays unchanged. Layout and fonts may differ.`:`Check the editor for import warnings.`}`;emit();
      }catch(e){problems.push(`${file.name}: ${e.message}`);results.push({name:file.name,editor:file.editor,error:e.message});}
    }
  }catch(e){problems.push(e.message);}
  finally{opening=false;error=problems.join(' ');if(!results.some(r=>r.delivered)&&!error)openMessage='Opening cancelled.';emit();}
  return {state:publicState(),results,source};
}
function queueFiles(paths,source){
  if(!shellReady){pendingLaunch.push({paths,source});return Promise.resolve({queued:true});}
  if(queuedRequests>=8){error='Too many open requests. Let the current files finish opening, then try again.';emit();return Promise.resolve({state:publicState(),results:[]});}
  queuedRequests++;
  const run=openQueue.then(()=>openFiles(paths,source));
  openQueue=run.catch(e=>{error=e.message;emit();}).finally(()=>{queuedRequests--;});
  return run;
}
async function chooseFiles(){
  const r=await dialog.showOpenDialog(win,{title:'Open in AE Studio',properties:['openFile','multiSelections'],filters:dialogFilters()});
  if(r.canceled)return {state:publicState(),results:[]};
  return queueFiles(r.filePaths,'Open dialog');
}
async function openArtcraftImage(filePath){
  const file=await validateFile(filePath);if(file.extension!=='png')throw Error('ArtCraft accepts a generated PNG image here.');
  await openEditor('artcraft');return importFile(views.get('artcraft').webContents,{...file,editor:'artcraft',action:'artcraft-import'},{artcraftImage:true});
}
function shortcut(action){
  const keys={open:'O',save:'S',undo:'Z',redo:'Y'};
  if(!keys[action]||!active)return;
  const contents=views.get(active).webContents;contents.focus();
  contents.sendInputEvent({type:'keyDown',keyCode:keys[action],modifiers:[process.platform==='darwin'?'meta':'control']});
  contents.sendInputEvent({type:'keyUp',keyCode:keys[action],modifiers:[process.platform==='darwin'?'meta':'control']});
}
async function closeEditor(){
  if(!active)return;
  const id=active;
  const choice=await dialog.showMessageBox(win,{type:'question',title:'Close editor',message:'Have you saved your work?',detail:'Closing this editor discards any unsaved changes. Switching to another editor keeps it open.',buttons:['Keep editing','Close editor'],defaultId:0,cancelId:0});
  if(choice.response===1){const view=views.get(id);win.contentView.removeChildView(view);if(!view.webContents.isDestroyed())view.webContents.close();views.delete(id);editorFiles.delete(id);home();}
}
app.whenReady().then(async()=>{
  try{const saved=JSON.parse(fs.readFileSync(path.join(dataDir,'workspace.json'),'utf8'));preferences=appearance.normalize(saved.preferences);saveFolder=typeof saved.saveFolder==='string'?saved.saveFolder:'';exportsList=Array.isArray(saved.exports)?saved.exports.filter(e=>typeof e.path==='string'&&typeof e.id==='string').slice(0,40):[];}catch{}
  nativeTheme.themeSource=preferences.theme;nativeTheme.on('updated',()=>emit());
  localSession(session.defaultSession,'shell');
  win=new BrowserWindow({width:1500,height:980,minWidth:1000,minHeight:700,show:!testMode,backgroundColor:nativeTheme.shouldUseDarkColors?'#13161d':'#f7f8fa',title:'AE Studio',icon:path.join(ROOT,'ui/assets/apple-english-logo.png'),webPreferences:{preload:path.join(ROOT,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Workspace',submenu:[{label:'Open file…',accelerator:'CmdOrCtrl+Shift+O',click:()=>chooseFiles().catch(e=>{error=e.message;emit();})},{label:'Home',accelerator:'CmdOrCtrl+Shift+H',click:home},{label:'Open in current editor',click:()=>shortcut('open')},{label:'Save in editor',click:()=>shortcut('save')},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{label:'Toggle sidebar',accelerator:'CmdOrCtrl+Shift+B',click:()=>setAppearance({sidebarCollapsed:!preferences.sidebarCollapsed})},{label:'Toggle compact toolbar',accelerator:'CmdOrCtrl+Shift+T',click:()=>setAppearance({toolbarCollapsed:!preferences.toolbarCollapsed})},{label:'Focus workspace',accelerator:'CmdOrCtrl+Shift+F',click:()=>setAppearance({sidebarCollapsed:!(preferences.sidebarCollapsed&&preferences.toolbarCollapsed),toolbarCollapsed:!(preferences.sidebarCollapsed&&preferences.toolbarCollapsed)})},{type:'separator'},{role:'togglefullscreen'}]}]));
  guard(win.webContents,'shell');win.on('resize',layout);
  win.on('close',event=>{
    if(quitting||testMode||views.size===0)return;
    event.preventDefault();
    dialog.showMessageBox(win,{type:'question',title:'Exit AE Studio',message:'Save your work before closing.',detail:'Open editors may contain unsaved changes. Use each editor’s Save or Export command first.',buttons:['Keep working','Exit'],defaultId:0,cancelId:0}).then(r=>{if(r.response===1){quitting=true;win.close();}});
  });
  win.on('closed',()=>{nativeTools?.cancel();backgroundTool?.cancel();connections?.cancel();for(const view of views.values())if(!view.webContents.isDestroyed())view.webContents.close();views.clear();});
  nativeTools=installNativeTools({ipcMain,dialog,shell,win,views,dataDir,getSaveFolder:()=>saveFolder,openFiles:queueFiles,openArtcraftImage,testDir,testMode,onExport:item=>{exportsList.unshift({...item,when:new Date().toISOString()});exportsList=exportsList.slice(0,40);persist();emit();}});
  backgroundTool=require('./integrations/background-bridge.cjs').createBackgroundTool({ipcMain,views});
  const handle=(channel,fn)=>ipcMain.handle(channel,(event,...args)=>{trusted(event);return fn(...args);});
  connections=require('./integrations/connections-bridge.cjs').createConnections({dataDir,safeStorage,shell,dialog,win,getSaveFolder:()=>saveFolder,openFiles:queueFiles,testMode,onDownload:item=>{exportsList.unshift({...item,when:new Date().toISOString()});exportsList=exportsList.slice(0,40);persist();emit();}});
  handle('studio:connections',(operation,args)=>connections.action(operation,args));
  handle('studio:appearance',setAppearance);handle('studio:state',publicState);handle('studio:formats',()=>macNative?macNative.formats():require('./format-catalog.cjs').rows());handle('studio:open',openEditor);handle('studio:home',home);handle('studio:close-editor',closeEditor);handle('studio:shortcut',shortcut);
  handle('studio:open-files',chooseFiles);
  handle('studio:dismiss-error',()=>{error='';emit();return publicState();});
  handle('studio:shell-dialog',visible=>{shellDialog=visible===true;layout();});
  handle('studio:registration-help',()=>shell.openExternal(installation.defaultsUrl));
  handle('studio:windows-defaults',()=>shell.openExternal(installation.defaultsUrl));
  handle('studio:user-data',()=>{fs.mkdirSync(dataDir,{recursive:true});return shell.openPath(dataDir);});
  handle('studio:installation',()=>({installed:installation.installed,platform:process.platform,dataDir,localAI:fs.existsSync(path.join(require('./runtime-paths.cjs').localAI,'runtime','python','bin','python3'))}));
  ipcMain.handle('studio:drop-files',(event,paths)=>{trustedDrop(event);return queueFiles(paths,'File drop');});
  handle('studio:install',async()=>{if(installing)return;installing=true;error='';emit();try{await require('./install.cjs').installEditors(locks.filter(l=>modules.find(m=>m.id===l.id)?.available!==false),editorRoot,message=>{setupMessage=message;emit();});}catch(e){error=e.message;}finally{installing=false;emit();}return publicState();});
  handle('studio:folder',async()=>{const r=await dialog.showOpenDialog(win,{title:'Choose a shared export folder',properties:['openDirectory','createDirectory']});if(!r.canceled){saveFolder=r.filePaths[0];persist();emit();}return publicState();});
  handle('studio:reveal',id=>{const item=exportsList.find(e=>e.id===id);if(item&&fs.existsSync(item.path))shell.showItemInFolder(item.path);});
  handle('studio:notices',()=>shell.openPath(path.join(ROOT,'notices')));
  await win.loadURL('studio://shell/index.html');
  shellReady=true;
  if(!testMode||process.env.STUDIO_TEST_INSTALLER==='1'){const launchFiles=fileArguments(process.argv,{defaultApp:process.defaultApp});if(launchFiles.length)queueFiles(launchFiles,'Startup');}
  for(const request of pendingLaunch.splice(0))queueFiles(request.paths,request.source);
  if(testMode)win.show();
  if(testMode&&process.env.STUDIO_TEST_MAC==='1'){await require('./mac-smoke.cjs').run({win,openEditor,openFiles,views,publicState,app,testDir});return;}
  if(testMode)await require(process.env.STUDIO_TEST_NETWORK==='1'?'./network-hangul-test.cjs':process.env.STUDIO_TEST_EXPERIENCE==='1'?'./experience-test.cjs':process.env.STUDIO_TEST_AE==='1'?'./ae-test.cjs':process.env.STUDIO_TEST_INSTALLER==='1'?'./installer-test.cjs':process.env.STUDIO_TEST_EXTENDED==='1'?'./extended-test.cjs':process.env.STUDIO_TEST_LOCAL_AI==='1'?'./local-ai-test.cjs':process.env.STUDIO_TEST_PDF_ADVANCED==='1'?'./advanced-pdf-test.cjs':process.env.STUDIO_TEST_ARTCRAFT==='1'?'./artcraft-test.cjs':process.env.STUDIO_TEST_NATIVE==='1'?'./native-smoke.cjs':process.env.STUDIO_TEST_FILES==='1'?'./file-smoke.cjs':'./smoke.cjs').run({win,openEditor,openFiles,queueFiles,home,views,shortcut,testDir,publicState,failures,app,nativeTools});
}).catch(e=>{console.error(e);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
