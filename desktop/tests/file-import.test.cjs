const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {importFile,assertEditor}=require('../file-import.cjs');const {validateFile}=require('../file-routing.cjs');
function contents({frame='main',input=true}={}){
  const bridge=new EventEmitter();bridge.attached=false;bridge.commands=[];
  bridge.attach=()=>{bridge.attached=true;};bridge.detach=()=>{bridge.attached=false;};bridge.isAttached=()=>bridge.attached;
  bridge.sendCommand=async(method,params)=>{bridge.commands.push({method,params});if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}};if(method==='DOM.describeNode')return {node:{nodeName:input?'INPUT':'DIV',attributes:['type','file']}};return {};};
  return {debugger:bridge,isDestroyed:()=>false,isCrashed:()=>false,getURL:()=>'studio://wordcraft/index.html',executeJavaScript:async()=>({canvas:true,loading:false}),focus:()=>{},sendInputEvent:event=>{if(event.type==='keyDown')setImmediate(()=>bridge.emit('message',{},'Page.fileChooserOpened',{frameId:frame,backendNodeId:7}));}};
}
test('file bridge refuses foreign origins and stopped editors',()=>{
  for(const url of ['https://example.com','studio://gridcraft/index.html','studio://wordcraft/other.html'])assert.throws(()=>assertEditor({...contents(),getURL:()=>url},'wordcraft'),/trusted local page/);
  assert.throws(()=>assertEditor({...contents(),isCrashed:()=>true},'wordcraft'),/editor stopped/);
});
test('photo-library file opening supplies a real user gesture to its deferred picker',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-raw-import-'));
  try{
    const name=path.join(dir,'fixture.dng');await fs.writeFile(name,'synthetic route fixture');const file=await validateFile(name);
    const wc=contents();wc.getURL=()=>'studio://lightcraft/index.html';
    wc.executeJavaScript=async(code,userGesture)=>{
      if(code.includes('lightcraft.command')){
        assert.equal(userGesture,true,'Browser picker requires activation from the requested file-open action');
        setImmediate(()=>wc.debugger.emit('message',{},'Page.fileChooserOpened',{frameId:'main',backendNodeId:7}));return null;
      }
      return {canvas:true,loading:false};
    };
    assert.equal((await importFile(wc,file)).delivered,true);
    assert.equal(wc.debugger.isAttached(),false);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('file bridge delivers only to a main-frame file input and always detaches',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-import-'));
  try{
    const name=path.join(dir,'fixture.docx');await fs.writeFile(name,'synthetic');const file=await validateFile(name);
    const valid=contents();const result=await importFile(valid,file);assert.equal(result.delivered,true);assert.equal(valid.debugger.isAttached(),false);assert.equal(valid.debugger.listenerCount('message'),0);
    assert.deepEqual(valid.debugger.commands.find(c=>c.method==='DOM.setFileInputFiles').params,{files:[file.path],backendNodeId:7});
    for(const options of [{frame:'subframe'},{input:false}]){
      const invalid=contents(options);await assert.rejects(importFile(invalid,file),/nested page|invalid file input/);assert.equal(invalid.debugger.isAttached(),false);assert.equal(invalid.debugger.commands.some(c=>c.method==='DOM.setFileInputFiles'),false);
      assert.deepEqual(invalid.debugger.commands.at(-1),{method:'Page.setInterceptFileChooserDialog',params:{enabled:false}});
    }
    await fs.appendFile(name,'changed');await assert.rejects(importFile(contents(),file),/changed while opening/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
