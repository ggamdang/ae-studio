'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
async function run({win,openEditor,openFiles,views,publicState,app,testDir}){
 const results=[];
 try{
  const state=publicState();assert.equal(state.modules.filter(m=>require('./mac-native.cjs').native(m.id)).length,13);assert(state.modules.filter(m=>require('./mac-native.cjs').native(m.id)).every(m=>m.installed));results.push('13 native apps discoverable');
  await openEditor('pdf-tools');const wc=views.get('pdf-tools').webContents;
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
