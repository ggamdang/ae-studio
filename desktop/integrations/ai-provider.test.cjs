const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');
const {createAIProvider,normalizeConfig,buildComfyWorkflow,buildArtcraftRequest}=require('./ai-provider.cjs');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSakAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const calls=[];const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-ai-fixture-'));
 const server=http.createServer(async(req,res)=>{
  const parts=[];for await(const p of req)parts.push(p);const raw=Buffer.concat(parts).toString();
  calls.push({url:req.url,method:req.method,headers:req.headers,body:raw?JSON.parse(raw):null});
  let value;
  if(req.url==='/system_stats')value={system:{comfyui_version:'fixture only'}};
  else if(req.url==='/object_info/CheckpointLoaderSimple')value={CheckpointLoaderSimple:{input:{required:{ckpt_name:[['synthetic-fixture.safetensors']]}}}};
  else if(req.url==='/prompt')value={prompt_id:'fixture-prompt'};
  else if(req.url==='/history/fixture-prompt')value={'fixture-prompt':{status:{completed:true,status_str:'success'},outputs:{'9':{images:[{filename:'fixture.png',subfolder:'',type:'output'}]}}}};
  else if(req.url.startsWith('/view?')||req.url==='/result.png'){res.writeHead(200,{'Content-Type':'image/png'});res.end(PNG);return;}
  else if(req.url.startsWith('/v1/omni_gen/models/'))value={success:true,models:[{model:'flux_1_schnell',full_name:'Synthetic ArtCraft catalog fixture',aspect_ratio_options:['square'],is_disabled:false}]};
  else if(req.url.startsWith('/v1/omni_api/generate/'))value={success:true,inference_job_token:'jinf_fixture'};
  else if(req.url==='/v1/omni_api/job_status/job/jinf_fixture')value={success:true,state:{status:{status:'complete_success',progress_percentage:100},maybe_result:{media_links:{cdn_url:`http://127.0.0.1:${server.address().port}/result.png`}}}};
  else {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 // Isolated temp fixture directory only; no user data or provider is touched.
 t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
 return {calls,dataDir,baseUrl:`http://127.0.0.1:${server.address().port}`};
}
test('server configuration rejects credential-bearing URLs and remote ComfyUI',()=>{
 for(const baseUrl of ['https://cloud.example','http://127.0.0.1:8188/path','http://user:secret@127.0.0.1:8188','file:///tmp'])assert.throws(()=>normalizeConfig({provider:'comfyui',baseUrl}));
 assert.throws(()=>normalizeConfig({provider:'artcraft',baseUrl:'https://lookalike.example'}));
 assert.equal(normalizeConfig({provider:'artcraft'}).baseUrl,'https://api.storyteller.ai');
});
test('fixed ComfyUI graph preserves prompt/seed and excludes custom or API nodes',()=>{
 const graph=buildComfyWorkflow({prompt:'a synthetic shape',model:'checkpoint.safetensors',seed:42,width:320,height:512,steps:8,workflow:{paid:'ignored'}});
 assert.equal(graph['6'].inputs.text,'a synthetic shape');assert.equal(graph['3'].inputs.seed,42);assert.equal(graph['5'].inputs.width,320);
 assert.deepEqual(Object.values(graph).map(n=>n.class_type).sort(),['CLIPTextEncode','CLIPTextEncode','CheckpointLoaderSimple','EmptyLatentImage','KSampler','SaveImage','VAEDecode']);
 assert.throws(()=>buildComfyWorkflow({prompt:'x',model:'x',width:513}));
});
test('ArtCraft request matches documented image/video field names and one-item bound',()=>{
 const image=buildArtcraftRequest({model:'flux_1_schnell',prompt:'test',imageUrls:['https://example.com/reference.png'],width:1024,height:1024},'uuid');
 assert.deepEqual(image,{idempotency_token:'uuid',model:'flux_1_schnell',prompt:'test',aspect_ratio:'square',image_batch_count:1,image_urls:['https://example.com/reference.png']});
 const video=buildArtcraftRequest({kind:'video',model:'seedance_2p0',prompt:'test',durationSeconds:6,startFrameUrl:'https://example.com/start.png'},'uuid2');
 assert.equal(video.duration_seconds,6);assert.equal(video.video_batch_count,1);assert.equal(video.start_frame_image_url,'https://example.com/start.png');assert.equal(video.generate_audio,false);
 assert.throws(()=>buildArtcraftRequest({model:'x',prompt:'x',imageUrls:['file:///private.png']},'uuid'));
});
test('cancelled approval causes zero generation requests and zero jobs',async t=>{
 const f=await fixture(t);const provider=createAIProvider({dataDir:f.dataDir,approveRun:async()=>false});provider.configure({provider:'comfyui',baseUrl:f.baseUrl});
 assert.deepEqual(await provider.generate({prompt:'test',model:'synthetic-fixture.safetensors'}),{cancelled:true});assert.equal(f.calls.length,0);assert.equal(provider.jobs().length,0);
});
test('local ComfyUI fixture roundtrip: connect, models, approve, submit, poll, import exact bytes',async t=>{
 const f=await fixture(t);let approvals=0;
 const provider=createAIProvider({dataDir:f.dataDir,approveRun:async request=>{approvals++;assert.equal(request.cost.paid,false);return true;}});
 provider.configure({provider:'comfyui',baseUrl:f.baseUrl});assert.equal((await provider.connection()).reachable,true);assert.equal((await provider.models())[0].id,'synthetic-fixture.safetensors');
 const job=await provider.generate({prompt:'a test fixture, not an AI output',model:'synthetic-fixture.safetensors',seed:99});assert.equal(job.status,'queued');assert.equal(approvals,1);
 assert.equal((await provider.poll(job.id)).status,'completed');const files=await provider.importResult(job.id);assert.equal(files.length,1);assert.deepEqual(fs.readFileSync(files[0].path),PNG);
 assert.equal(f.calls.find(c=>c.url==='/prompt').body.prompt['3'].inputs.seed,99);
 assert.ok(f.calls.every(c=>!c.headers.authorization));
 const reopened=createAIProvider({dataDir:f.dataDir});assert.equal(reopened.jobs()[0].status,'completed');
});
test('ArtCraft fixture enforces unknown cost approval, bearer auth, persistent job id and secret-free files',async t=>{
 const f=await fixture(t);const key='synthetic-key-not-real';let approval;
 const provider=createAIProvider({dataDir:f.dataDir,approveRun:async r=>{approval=r;assert.equal(f.calls.filter(c=>c.method==='POST').length,0);return true;}});
 provider.configure({provider:'artcraft',baseUrl:f.baseUrl,credential:key});
 const connection=await provider.connection();assert.equal(connection.authenticationVerified,false);
 const job=await provider.generate({prompt:'synthetic test',model:'flux_1_schnell'});
 assert.equal(approval.cost.known,false);assert.equal(approval.cost.amount,null);assert.equal(approval.cost.paid,true);
 const submitted=f.calls.find(c=>c.url==='/v1/omni_api/generate/image');assert.equal(submitted.headers.authorization,'Bearer '+key);assert.equal(submitted.body.idempotency_token,job.idempotencyToken);
 assert.equal((await provider.poll(job.id)).status,'completed');const [result]=await provider.importResult(job.id);assert.deepEqual(fs.readFileSync(result.path),PNG);
 assert.equal(f.calls.find(c=>c.url==='/result.png').headers.authorization,undefined);
 for(const name of ['settings.json','jobs.json'])assert.ok(!fs.readFileSync(path.join(f.dataDir,'ai',name),'utf8').includes(key));
 const restarted=createAIProvider({dataDir:f.dataDir});assert.equal(restarted.status().credentialConfigured,false);
 provider.configure({provider:'comfyui',baseUrl:f.baseUrl});assert.equal(provider.status().credentialConfigured,false);
});
test('network failure after submit remains uncertain and is never automatically retried',async t=>{
 const f=await fixture(t);let requests=0;
 const provider=createAIProvider({dataDir:f.dataDir,approveRun:async()=>true,fetchImpl:async()=>{requests++;throw Error('simulated transport failure');}});
 provider.configure({provider:'artcraft',baseUrl:f.baseUrl,credential:'synthetic-key'});
 await assert.rejects(provider.generate({prompt:'test',model:'flux_1_schnell'}),/may have been accepted/);assert.equal(requests,1);assert.equal(provider.jobs()[0].status,'submission_unknown');
 await provider.poll(provider.jobs()[0].id);assert.equal(requests,1);
});
test('persisted jobs cannot introduce unsafe output paths or alternate provider origins',async t=>{
 const f=await fixture(t);const folder=path.join(f.dataDir,'ai');fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(folder,'jobs.json'),JSON.stringify([{id:'../../escape',provider:'artcraft',baseUrl:f.baseUrl,status:'completed',outputs:[]},{id:'11111111-1111-1111-1111-111111111111',provider:'artcraft',baseUrl:'https://unexpected.example',status:'completed'}]));
 assert.equal(createAIProvider({dataDir:f.dataDir}).jobs().length,0);
});

test('bundled jobs authenticate privately, save automatically, and reopen without a running server',async t=>{
 const f=await fixture(t);const token='synthetic-private-desktop-token';let running=true;
 const provider=createAIProvider({dataDir:f.dataDir,getLocalConnection:()=>{if(!running)throw Error('stopped');return {baseUrl:f.baseUrl,session:'test-session',token};},approveRun:async()=>true});
 const job=await provider.generate({prompt:'fixture',model:'synthetic-fixture.safetensors'});
 await assert.rejects(provider.generate({prompt:'second',model:'synthetic-fixture.safetensors'}),/current image/);
 const completed=await provider.poll(job.id);assert.equal(completed.saved,true);
 assert.ok(f.calls.every(c=>c.headers['x-studio-session']===token));
 for(const name of ['settings.json','jobs.json'])assert.ok(!fs.readFileSync(path.join(f.dataDir,'ai',name),'utf8').includes(token));
 running=false;const calls=f.calls.length;const reopened=createAIProvider({dataDir:f.dataDir,getLocalConnection:()=>{throw Error('stopped');}});
 assert.deepEqual(fs.readFileSync((await reopened.importResult(job.id))[0].path),PNG);assert.equal(f.calls.length,calls);
});

test('stopping owned generation cancels its pending record and leaves hosted jobs alone',async t=>{
 const f=await fixture(t);const provider=createAIProvider({dataDir:f.dataDir,getLocalConnection:()=>({baseUrl:f.baseUrl,session:'fixture',token:'private'}),approveRun:async()=>true});
 const local=await provider.generate({prompt:'local',model:'synthetic-fixture.safetensors'});provider.endLocalJobs();assert.equal(provider.jobs().find(j=>j.id===local.id).status,'cancelled');
 provider.configure({provider:'artcraft',baseUrl:f.baseUrl,credential:'synthetic-key'});const hosted=await provider.generate({prompt:'hosted fixture',model:'fixture'});provider.endLocalJobs();assert.equal(provider.jobs().find(j=>j.id===hosted.id).status,'queued');
});
