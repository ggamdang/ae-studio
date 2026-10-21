'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {readResponseStream,createCloudServices,promptText}=require('../integrations/cloud-services.cjs');
function sse(events){const bytes=Buffer.from(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));return new Response(new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
test('ChatGPT stream preserves Korean and rejects incomplete or failed answers after partial text',async()=>{
 assert.equal(await readResponseStream(sse([{type:'response.output_text.delta',delta:'안녕하세요 🐱'},{type:'response.completed'}])),'안녕하세요 🐱');
 await assert.rejects(readResponseStream(sse([{type:'response.output_text.delta',delta:'partial'}])),/before ChatGPT completed/);
 for(const type of ['response.failed','response.incomplete','error'])await assert.rejects(readResponseStream(sse([{type:'response.output_text.delta',delta:'partial'},{type}])),/did not complete/);
 await assert.rejects(readResponseStream(new Response('',{status:429})),/429/);assert.throws(()=>promptText(' '.repeat(4)));assert.throws(()=>promptText('a'.repeat(32001)));
});
test('ChatGPT uses account-specific models, permitted payload fields and no retry',async()=>{
 let calls=0;const accounts={account:()=>({scopes:['chatgpt.tokens.use.direct']}),access:async()=>'oauth-fixture',request:async()=>({models:[{visibility:'list',slug:'fixture-model',display_name:'Fixture'},{visibility:'hide',slug:'secret',display_name:'Hidden'}]}),fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.model,'fixture-model');assert.ok(Array.isArray(body.input));assert.equal(body.max_output_tokens,undefined);assert.equal(options.headers.Authorization,'Bearer oauth-fixture');return sse([{type:'response.output_text.delta',delta:'okay'},{type:'response.completed'}]);}};
 const cloud=createCloudServices({accounts,downloadRoot:os.tmpdir()});assert.deepEqual(await cloud.models('a'),[{id:'fixture-model',name:'Fixture'}]);await assert.rejects(cloud.chatgpt('a','secret','hi'),/Choose a model/);assert.equal(calls,0);assert.equal(await cloud.chatgpt('a','fixture-model','hi'),'okay');assert.equal(calls,1);
});
test('Drive uploads chunks as a new file and refuses credential forwarding to another host',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-drive-')),input=path.join(dir,'fixture.bin');await fs.writeFile(input,Buffer.alloc(9*1024**2,7));let puts=0,hostile=false;
 const accounts={account:()=>({}),access:async()=>'fixture',fetchImpl:async(url,options)=>{if(options.method==='POST'){assert.equal(JSON.parse(options.body).name,'fixture.bin');return new Response('',{headers:{location:hostile?'https://attacker.test/upload/drive/stolen':'https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture'}});}puts++;assert.equal(options.method,'PUT');assert.ok(Buffer.isBuffer(options.body));if(puts===1){assert.equal(options.body.length,8*1024**2);return new Response('',{status:308,headers:{range:'bytes=0-8388607'}});}return Response.json({id:'new',name:'fixture.bin'});}};
 try{const cloud=createCloudServices({accounts,downloadRoot:dir});assert.equal((await cloud.driveUpload('a',input)).id,'new');assert.equal(puts,2);hostile=true;await assert.rejects(cloud.driveUpload('a',input),/unexpected upload/);assert.equal(puts,2);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Drive downloads to unique local copies and converts native Google documents',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-drive-copy-'));let exports=0;
 const accounts={account:()=>({}),access:async()=>'fixture',request:async()=>({name:'보고서',mimeType:'application/vnd.google-apps.document'}),fetchImpl:async url=>{assert.match(url,/export\?mimeType=/);return new Response('Office fixture');}};
 try{const cloud=createCloudServices({accounts,downloadRoot:dir,onDownload:()=>exports++});const a=await cloud.driveDownload('a','safe-id'),b=await cloud.driveDownload('a','safe-id');assert.equal(a.name,'보고서.docx');assert.notEqual(a.path,b.path);assert.equal(await fs.readFile(a.path,'utf8'),'Office fixture');assert.equal(exports,2);await assert.rejects(cloud.driveDownload('a','../bad'),/Choose/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
