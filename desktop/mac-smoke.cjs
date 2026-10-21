'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
async function run({win,openEditor,openFiles,views,publicState,app,testDir,failures=[]}){
 const results=[];
 try{
  const state=publicState();assert.equal(state.modules.filter(m=>require('./mac-native.cjs').native(m.id)).length,13);assert(state.modules.filter(m=>require('./mac-native.cjs').native(m.id)).every(m=>m.installed));results.push('13 native apps discoverable');
  const js=code=>win.webContents.executeJavaScript(code);
  const captureShell=async name=>{await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await new Promise(r=>setTimeout(r,200));await fs.writeFile(path.join(testDir,name),(await win.webContents.capturePage()).toPNG());};
  const waitFor=async code=>{const until=Date.now()+15000;while(Date.now()<until){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Shell did not become ready: '+code+'; '+JSON.stringify(failures.filter(f=>f.host==='shell')));};
  await waitFor(`document.querySelectorAll('#tool-grid .tool-card').length===${state.modules.length} && document.querySelectorAll('#navigation .nav-item').length===${state.modules.length}`);
  assert.equal(await js("document.querySelector('header #choose-folder')===null"),true);
  await fs.mkdir(testDir,{recursive:true});
  for(const theme of ['light','dark']){
   await js(`document.querySelector('button[data-theme="${theme}"]').click()`);
   await waitFor(`document.documentElement.dataset.theme==='${theme}'`);
   assert.equal(await js("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()"),theme==='dark'?'#13161d':'#f7f8fa');
   assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
   await captureShell('home-'+theme+'.png');
  }
  await js("document.getElementById('toggle-sidebar').click();document.getElementById('toggle-toolbar').click()");
  await waitFor("document.body.classList.contains('sidebar-collapsed')&&document.body.classList.contains('toolbar-collapsed')");
  const saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'workspace.json'),'utf8'));
  assert.deepEqual(saved.preferences,{theme:'dark',sidebarCollapsed:true,toolbarCollapsed:true});
  await js("document.getElementById('settings').click()");
  await waitFor("document.getElementById('settings-dialog').open&&document.querySelectorAll('#format-table tbody tr').length>170");
  await captureShell('settings-dark.png');
  await js("document.getElementById('close-settings').click();window.studio.appearance({theme:'system',sidebarCollapsed:false,toolbarCollapsed:false})");
  await waitFor("!document.body.classList.contains('sidebar-collapsed')&&!document.body.classList.contains('toolbar-collapsed')");
  assert.deepEqual(failures.filter(f=>f.host==='shell'),[]);
  results.push('Visible tool cards, navigation, light/dark themes, compact controls, saved preferences and format settings');
  const connectionState=await win.webContents.executeJavaScript("window.studio.connections('state')");
  assert.equal(connectionState.oauth.error,'');assert.equal(connectionState.oauth.accounts.length,0,'A shared installer must not include personal accounts');
  const registrationIncluded=require('node:fs').existsSync(path.join(__dirname,'integrations/google-desktop.json'));
  assert.equal(connectionState.oauth.googleConfigured,registrationIncluded);results.push(registrationIncluded?'Google registration ready; no personal accounts bundled':'Custom build requires Google registration import');
  await openEditor('pdf-tools');const wc=views.get('pdf-tools').webContents;
  assert.deepEqual(views.get('pdf-tools').getBounds(),require('./appearance.cjs').geometry(publicState().preferences,...win.getContentSize(),false));
  const capabilities=await require('./pdf/bridge.cjs').run('capabilities');assert.equal(capabilities.ok,true);results.push('isolated PDF worker starts');
  const shot=await win.webContents.capturePage();await fs.mkdir(testDir,{recursive:true});await fs.writeFile(path.join(testDir,'home.png'),shot.toPNG());
  const toolsShot=await wc.capturePage();await fs.writeFile(path.join(testDir,'pdf-tools.png'),toolsShot.toPNG());
  await openEditor('artcraft');const art=views.get('artcraft').webContents;
  const artResult=await require('./artcraft/smoke.cjs').run({contents:art,testDir:path.join(testDir,'artcraft-workflows')});
  assert.equal(artResult.passed,true,artResult.error);results.push('ArtCraft canvas, cutout, 3D, pose, export and project roundtrip');
  for(const file of [path.join(testDir,'artcraft-workflows/roundtrip.artcraft'),path.join(__dirname,'artcraft/renderer/local-assets/mannequin.glb')]){
   const result=await openFiles([file],'ArtCraft file-opening test');assert(result.results.some(r=>r.delivered),result.state.error);results.push('ArtCraft global import '+path.extname(file));
  }
  await fs.writeFile(path.join(testDir,'artcraft.png'),(await art.capturePage()).toPNG());
  if(process.env.AE_MAC_FIXTURES){
   const fixtures=JSON.parse(process.env.AE_MAC_FIXTURES);
   for(const file of fixtures){const before=await fs.readFile(file);const opened=await openFiles([file],'Mac integration test');assert.equal(opened.state.error,'');assert(opened.results.some(r=>r.delivered));assert.deepEqual(await fs.readFile(file),before);results.push('native dispatch preserves '+path.basename(file));}
   // Exercise macOS LaunchServices -> Electron open-file -> native editor.
   const file=fixtures[0],ledger=path.join(testDir,'finder-event.json');await fs.rm(ledger,{force:true});
   await new Promise((resolve,reject)=>require('node:child_process').execFile('/usr/bin/open',['-a',path.resolve(__dirname,'../../..'),file],e=>e?reject(e):resolve()));
   const end=Date.now()+30000;let event;
   while(Date.now()<end){try{event=JSON.parse(await fs.readFile(ledger,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,200));}}
   assert(event&&event.paths.some(p=>p.normalize('NFC')===file.normalize('NFC'))&&!event.error&&event.results.some(r=>r.delivered),'Finder open-file event must reach the correct editor');results.push('Finder open-file event routed');
  }
  await fs.writeFile(path.join(testDir,'result.json'),JSON.stringify({ok:true,results,capabilities},null,2));app.exit(0);
 }catch(e){await fs.mkdir(testDir,{recursive:true});await fs.writeFile(path.join(testDir,'result.json'),JSON.stringify({ok:false,results,error:e.stack},null,2));app.exit(1);}
}
module.exports={run};
