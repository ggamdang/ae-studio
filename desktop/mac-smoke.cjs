'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
async function run({win,openEditor,views,publicState,app,testDir}){
 const results=[];
 try{
  const state=publicState();assert.equal(state.modules.filter(m=>require('./mac-native.cjs').native(m.id)).length,13);assert(state.modules.filter(m=>require('./mac-native.cjs').native(m.id)).every(m=>m.installed));results.push('13 native apps discoverable');
  await openEditor('pdf-tools');const wc=views.get('pdf-tools').webContents;
  const capabilities=await require('./pdf/bridge.cjs').run('capabilities');assert.equal(capabilities.ok,true);results.push('isolated PDF worker starts');
  const shot=await win.webContents.capturePage();await fs.mkdir(testDir,{recursive:true});await fs.writeFile(path.join(testDir,'home.png'),shot.toPNG());
  const toolsShot=await wc.capturePage();await fs.writeFile(path.join(testDir,'pdf-tools.png'),toolsShot.toPNG());
  await openEditor('artcraft');assert((await views.get('artcraft').webContents.getTitle()).length>0);results.push('ArtCraft renderer loads');
  await fs.writeFile(path.join(testDir,'result.json'),JSON.stringify({ok:true,results,capabilities},null,2));app.exit(0);
 }catch(e){await fs.mkdir(testDir,{recursive:true});await fs.writeFile(path.join(testDir,'result.json'),JSON.stringify({ok:false,results,error:e.stack},null,2));app.exit(1);}
}
module.exports={run};
