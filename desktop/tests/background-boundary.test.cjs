'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createBackgroundTool}=require('../integrations/background-bridge.cjs');

test('local background removal rejects foreign frames, paths and malformed payloads before starting a worker',async()=>{
  let handler,spawns=0;
  const frame={url:'studio://artcraft/index.html'},contents={mainFrame:frame};
  createBackgroundTool({ipcMain:{handle:(name,fn)=>{assert.equal(name,'studio:artcraft-remove-background');handler=fn;}},views:new Map([['artcraft',{webContents:contents}]]),spawnImpl:()=>{spawns++;throw Error('Unexpected worker');}});
  await assert.rejects(()=>handler({sender:{},senderFrame:frame},'aGVsbG8='),/Untrusted/);
  await assert.rejects(()=>handler({sender:contents,senderFrame:{url:frame.url}},'aGVsbG8='),/Untrusted/);
  for(const invalid of ['C:\\private.png','data:image/png;base64,aGVsbG8=',{},null,'','%%%=', 'abc']){
    await assert.rejects(()=>handler({sender:contents,senderFrame:frame},invalid),/32 MB/);
  }
  assert.equal(spawns,0);
});
