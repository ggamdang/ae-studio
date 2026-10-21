'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const bridge=require('../pdf/bridge.cjs');
const {installNativeTools}=require('../native-tools.cjs');

test('certificate paths come only from the native picker and trust can be cleared',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'studio-cert-boundary-'));
  const input=path.join(folder,'sample.pdf'),certificate=path.join(folder,'owner.p12'),trust=path.join(folder,'trusted.pem');
  for(const file of [input,certificate,trust])fs.writeFileSync(file,'synthetic test fixture');
  const handlers=new Map(),frame={url:'studio://pdf-tools/index.html'},contents={mainFrame:frame};
  const event={sender:contents,senderFrame:frame};
  let chosen=[],captured;
  const originalRun=bridge.run;
  bridge.run=async(action,options)=>{captured={action,options:{...options}};return {ok:true,outputs:[],warnings:[]};};
  try{
    const tools=installNativeTools({
      ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
      dialog:{showOpenDialog:async()=>({canceled:false,filePaths:chosen})},shell:{},win:{},
      views:new Map([['pdf-tools',{webContents:contents}]]),dataDir:path.join(folder,'state'),
      getSaveFolder:()=>folder,openFiles:()=>{},testMode:true,testDir:folder
    });
    const call=(method,...args)=>handlers.get('tools:'+method)(event,...args);
    tools.addPDFInputs([input]);
    await assert.rejects(()=>call('pdf-run','certificate-sign',{certificatePath:'C:\\arbitrary-secret.pfx'}),/Choose your/);
    chosen=[certificate];const selection=await call('pdf-pick','certificate');
    assert.equal(selection.certificate.name,'owner.p12');
    assert.equal(JSON.stringify(selection).includes(folder),false);
    await call('pdf-run','certificate-sign',{certificatePath:'C:\\arbitrary-secret.pfx',certificatePassword:'test-only-secret',trustCertificatePaths:['C:\\unselected.pem']});
    assert.equal(captured.options.certificatePath,certificate);
    assert.equal(captured.options.certificatePassword,'test-only-secret');
    assert.equal(captured.options.trustCertificatePaths,undefined);
    chosen=[trust];await call('pdf-pick','trust');
    await call('pdf-run','verify-signature',{trustCertificatePaths:['C:\\unselected.pem']});
    assert.deepEqual(captured.options.trustCertificatePaths,[trust]);
    assert.equal(captured.options.certificatePath,undefined);
    await call('pdf-pick','clear-trust');
    await call('pdf-run','verify-signature',{});
    assert.deepEqual(captured.options.trustCertificatePaths,[]);
    chosen=[input];await assert.rejects(()=>call('pdf-pick','certificate'),/file type/);
    assert.throws(()=>handlers.get('tools:pdf-selection')({sender:contents,senderFrame:{url:frame.url}}),/Untrusted/);
  }finally{
    bridge.run=originalRun;
    const resolved=path.resolve(folder);
    if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('studio-cert-boundary-'))fs.rmSync(resolved,{recursive:true,force:true});
  }
});
