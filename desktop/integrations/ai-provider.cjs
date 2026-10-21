'use strict';
// Original Unified Studio adapter. ArtCraft wire contracts: artcraft-v0.41.0,
// _docs/artcraft_omni_api.md and artcraft_api_defs/src/omni_api. No upstream assets.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const MAX_JSON=8*1024*1024, MAX_MEDIA=256*1024*1024;
const TERMINAL=new Set(['completed','failed','cancelled','submission_unknown']);
const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']);
const JOB_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function normalizeConfig(value={}){
  if(!['comfyui','artcraft'].includes(value.provider))throw Error('Choose ComfyUI or ArtCraft.');
  const u=new URL(value.baseUrl||(value.provider==='comfyui'?'http://127.0.0.1:8188':'https://api.storyteller.ai'));
  const local=LOOPBACK.has(u.hostname);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Use a server origin without a path, credentials, query, or fragment.');
  if(!['http:','https:'].includes(u.protocol))throw Error('Unsupported server protocol.');
  if(value.provider==='comfyui'&&!local)throw Error('ComfyUI must run on this computer. Remote or paid ComfyUI services are not supported.');
  if(value.provider==='artcraft'&&!local&&u.origin!=='https://api.storyteller.ai')throw Error('Use the official ArtCraft API or a local development server.');
  return {provider:value.provider,baseUrl:u.origin,localMode:value.provider==='comfyui'&&value.localMode==='bundled'?'bundled':'external'};
}
function string(value,name,max=12000){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${name} is missing or too long.`);return value.trim();}
function integer(value,fallback,min,max,name){const n=value===undefined||value===''?fallback:Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`${name} must be an integer from ${min} to ${max}.`);return n;}
function publicReference(value){const u=new URL(string(value,'Reference URL',4096));if(u.protocol!=='https:'||u.username||u.password||LOOPBACK.has(u.hostname))throw Error('ArtCraft references must be public HTTPS URLs.');return u.href;}
function buildComfyWorkflow(input){
  const prompt=string(input.prompt,'Prompt'),model=string(input.model,'Checkpoint',1024);
  const width=integer(input.width,512,64,2048,'Width'),height=integer(input.height,512,64,2048,'Height');
  if(width%8||height%8)throw Error('ComfyUI dimensions must be multiples of 8.');
  const seed=integer(input.seed,Math.floor(Math.random()*0x100000000),0,Number.MAX_SAFE_INTEGER,'Seed');
  const steps=integer(input.steps,20,1,80,'Steps');
  // Fixed local core-node graph. Arbitrary/custom/API nodes are never accepted.
  return {
    '3':{class_type:'KSampler',inputs:{cfg:7,denoise:1,latent_image:['5',0],model:['4',0],negative:['7',0],positive:['6',0],sampler_name:'euler',scheduler:'normal',seed,steps}},
    '4':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:model}},
    '5':{class_type:'EmptyLatentImage',inputs:{batch_size:1,width,height}},
    '6':{class_type:'CLIPTextEncode',inputs:{clip:['4',1],text:prompt}},
    '7':{class_type:'CLIPTextEncode',inputs:{clip:['4',1],text:typeof input.negativePrompt==='string'?input.negativePrompt.slice(0,12000):''}},
    '8':{class_type:'VAEDecode',inputs:{samples:['3',0],vae:['4',2]}},
    '9':{class_type:'SaveImage',inputs:{filename_prefix:'UnifiedStudio',images:['8',0]}}
  };
}
function buildArtcraftRequest(input,id){
  const kind=input.kind||'image';if(!['image','video'].includes(kind))throw Error('ArtCraft supports image or video requests here.');
  const body={idempotency_token:id,model:string(input.model,'Model',100),prompt:string(input.prompt,'Prompt')};
  const aspects=['auto','square','wide_three_by_two','wide_four_by_three','wide_five_by_four','wide_sixteen_by_nine','wide_twenty_one_by_nine','tall_two_by_three','tall_three_by_four','tall_four_by_five','tall_nine_by_sixteen','tall_nine_by_twenty_one','wide','tall','auto_2k','auto_3k','auto_4k','square_hd'];
  const ratio=input.aspectRatio||(input.width>input.height?'wide_sixteen_by_nine':input.width<input.height?'tall_nine_by_sixteen':'square');
  if(!aspects.includes(ratio))throw Error('Unsupported aspect ratio.');body.aspect_ratio=ratio;
  if(input.resolution){if(!['one_k','two_k','three_k','four_k','half_k','four_eighty_p','seven_twenty_p','ten_eighty_p'].includes(input.resolution))throw Error('Unsupported resolution.');body.resolution=input.resolution;}
  if(input.quality){if(!['low','medium','high'].includes(input.quality))throw Error('Unsupported quality.');body.quality=input.quality;}
  if(kind==='image'){
    body.image_batch_count=1;
    if(input.imageUrls?.length){if(!Array.isArray(input.imageUrls)||input.imageUrls.length>8)throw Error('Use up to eight reference URLs.');body.image_urls=input.imageUrls.map(publicReference);}
  }else{
    body.video_batch_count=1;body.duration_seconds=integer(input.durationSeconds,5,1,30,'Duration');body.generate_audio=input.generateAudio===true;
    if(input.negativePrompt)body.negative_prompt=String(input.negativePrompt).slice(0,12000);
    if(input.startFrameUrl)body.start_frame_image_url=publicReference(input.startFrameUrl);
    if(input.endFrameUrl)body.end_frame_image_url=publicReference(input.endFrameUrl);
    if(input.imageUrls?.length){if(!Array.isArray(input.imageUrls)||input.imageUrls.length>8)throw Error('Use up to eight reference URLs.');body.reference_image_urls=input.imageUrls.map(publicReference);}
  }
  return body;
}
async function readLimited(response,max){
  if(Number(response.headers.get('content-length'))>max)throw Error('Provider response is too large.');
  const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
  const chunks=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max){await reader.cancel();throw Error('Provider response is too large.');}chunks.push(Buffer.from(value));}
  return Buffer.concat(chunks,total);
}
function createAIProvider({dataDir,fetchImpl=fetch,approveRun=async()=>false,getLocalConnection=null}={}){
  if(!dataDir)throw Error('An AI data directory is required.');
  const root=path.resolve(dataDir,'ai');const configFile=path.join(root,'settings.json'),jobsFile=path.join(root,'jobs.json');
  let config={provider:'comfyui',baseUrl:'http://127.0.0.1:8188',localMode:getLocalConnection?'bundled':'external'},credential='',records=[],busy=false;
  try{config=normalizeConfig(JSON.parse(fs.readFileSync(configFile,'utf8')));}catch{}
  try{records=JSON.parse(fs.readFileSync(jobsFile,'utf8'));if(!Array.isArray(records))records=[];records=records.filter(j=>{try{return j&&JOB_ID.test(j.id)&&normalizeConfig(j).baseUrl===j.baseUrl;}catch{return false;}}).slice(0,100);for(const job of records)if(job.status==='submitting')job.status='submission_unknown';}catch{}
  function atomicWrite(file,value){const temp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx',flush:true});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
  function save(){fs.mkdirSync(root,{recursive:true});atomicWrite(configFile,config);atomicWrite(jobsFile,records.slice(0,100));}
  // Jobs from a previous owned process cannot still be executing after restart.
  for(const job of records)if(job.localMode==='bundled'&&!TERMINAL.has(job.status)){job.status='cancelled';job.error='Local AI was closed before this image finished. Start a new generation when ready.';}
  function publicJob(job){const {outputs,saved,...safe}=job;return {...safe,saved:!!saved?.length,outputCount:outputs?.length||0};}
  function localHeaders(cfg){if(cfg.localMode!=='bundled')return {};const c=getLocalConnection?.();if(!c||c.baseUrl!==cfg.baseUrl||(cfg.session&&cfg.session!==c.session))throw Error('This local AI session has ended. Saved images are still available.');return {'X-Studio-Session':c.token};}
  function effectiveConfig(){if(config.localMode!=='bundled')return {...config};const c=getLocalConnection?.();if(!c)throw Error('Start local AI first.');return {...config,baseUrl:c.baseUrl,session:c.session};}
  function status(){return {...config,credentialConfigured:!!credential,credentialStorage:'session only',busy,capabilities:{image:true,video:config.provider==='artcraft',localComposition:false},hasCompletedJobs:records.some(j=>j.status==='completed')};}
  function configure(value){if(busy)throw Error('Wait for the current request to finish.');const next=normalizeConfig(value);if(next.provider!==config.provider||next.baseUrl!==config.baseUrl)credential='';if(Object.hasOwn(value,'credential')){if(typeof value.credential!=='string'||/[\r\n]/.test(value.credential)||value.credential.length>4096)throw Error('Invalid credential.');credential=value.credential.trim();}config=next;save();return status();}
  async function jsonAt(cfg,route,{body,auth=false,timeout=15000}={}){
    const headers={Accept:'application/json',...localHeaders(cfg)};if(body!==undefined)headers['Content-Type']='application/json';
    if(auth){if(cfg.provider==='artcraft'&&!credential)throw Error('Enter an ArtCraft API key. API access must be enabled by ArtCraft.');if(credential)headers.Authorization=`Bearer ${credential}`;}
    const response=await fetchImpl(cfg.baseUrl+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeout)});
    if(!response.ok){await response.body?.cancel();const e=Error(`Provider returned HTTP ${response.status}. ${response.status===401?'Check your API access and key.':response.status===402?'Provider credits are required.':''}`);e.status=response.status;throw e;}
    const bytes=await readLimited(response,MAX_JSON);let result;try{result=JSON.parse(bytes.toString('utf8'));}catch{throw Error('Provider returned invalid JSON.');}
    if(result.success===false)throw Error('Provider reported an unsuccessful request.');return result;
  }
  async function models(kind='image'){
    if(!['image','video'].includes(kind))throw Error('Unsupported model type.');
    if(config.provider==='comfyui'){
      if(kind==='video')return [];
      const info=await jsonAt(effectiveConfig(),'/object_info/CheckpointLoaderSimple');
      const choices=info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
      if(!Array.isArray(choices))throw Error('The server did not expose compatible checkpoint models.');
      return choices.filter(v=>typeof v==='string').map(id=>({id,name:id,kind,disabled:false}));
    }
    const response=await jsonAt(config,`/v1/omni_gen/models/${kind}?provider=artcraft`);
    if(!Array.isArray(response.models))throw Error('ArtCraft returned an invalid model catalog.');
    return response.models.filter(m=>m&&typeof m.model==='string').map(m=>({id:m.model,name:m.full_name||m.model,kind,disabled:!!m.is_disabled,aspectRatios:m.aspect_ratio_options||[],resolutions:m.resolution_options||[],qualities:m.quality_options||[],referenceImages:!!(m.image_refs_supported||m.image_references_supported)}));
  }
  async function connection(){
    if(config.provider==='comfyui'){const info=await jsonAt(effectiveConfig(),'/system_stats');return {...status(),reachable:true,message:config.localMode==='bundled'?'Local AI is ready. SDXL is included.':'Local ComfyUI responded. A compatible checkpoint is required.',system:info.system?.comfyui_version||null};}
    const catalog=await models();return {...status(),reachable:true,authenticationVerified:false,modelCount:catalog.length,message:'ArtCraft catalog reached. API-key access and generation have not been verified.'};
  }
  function estimate(input){
    if(config.provider==='comfyui'){buildComfyWorkflow(input);if(input.kind&&input.kind!=='image')throw Error('This local ComfyUI adapter currently generates images.');return {amount:0,currency:'provider fees',known:true,paid:false,description:'Local core-node workflow. Uses your computer and installed checkpoint; no paid API nodes.'};}
    buildArtcraftRequest(input,randomUUID());return {amount:null,currency:'ArtCraft credits',known:false,paid:true,description:'ArtCraft may charge your account. A compatible API-key price endpoint is not documented; this integration cannot quote a cost.'};
  }
  async function generate(input){
    if(busy)throw Error('A generation submission is already in progress.');
    busy=true;
    try{
      const cfg=effectiveConfig(),id=randomUUID(),kind=input.kind||'image',cost=estimate(input);
      if(cfg.localMode==='bundled'&&records.some(j=>j.localMode==='bundled'&&j.session===cfg.session&&!TERMINAL.has(j.status)))throw Error('Wait for the current image, or cancel it before generating another.');
      if(cfg.localMode==='bundled'&&(input.width>1536||input.height>1536||input.width*input.height>1572864))throw Error('Use up to 1.5 megapixels with the bundled model. Try 1024 × 1024.');
      if(cfg.provider==='artcraft'&&!credential)throw Error('Enter an ArtCraft API key. API access must be enabled by ArtCraft.');
      const body=cfg.provider==='comfyui'?{prompt:buildComfyWorkflow(input),client_id:id}:buildArtcraftRequest(input,id);
      const request={provider:cfg.provider,localMode:cfg.localMode,baseUrl:cfg.baseUrl,kind,model:input.model,prompt:input.prompt,cost,count:1,width:input.width,height:input.height,durationSeconds:body.duration_seconds,referenceCount:(body.image_urls||body.reference_image_urls||[]).length+(body.start_frame_image_url?1:0)+(body.end_frame_image_url?1:0)};
      if(await approveRun(Object.freeze(request))!==true)return {cancelled:true};
      const job={id,...cfg,kind,model:input.model,prompt:input.prompt,idempotencyToken:id,status:'submitting',createdAt:new Date().toISOString(),outputs:[]};records.unshift(job);records=records.slice(0,100);save();
      try{
        const reply=await jsonAt(cfg,cfg.provider==='comfyui'?'/prompt':`/v1/omni_api/generate/${kind}`,{body,auth:cfg.provider==='artcraft',timeout:45000});
        const providerId=cfg.provider==='comfyui'?reply.prompt_id:reply.inference_job_token;
        if(typeof providerId!=='string'||!providerId||providerId.length>300)throw Error('Provider did not return a job identifier.');
        job.providerId=providerId;job.status='queued';save();return publicJob(job);
      }catch(error){job.status=error.status&&error.status<500?'failed':'submission_unknown';job.error=job.status==='submission_unknown'?'The request may have been accepted. Check the provider before starting another generation; this app will not retry automatically.':error.message;save();throw Error(job.error);}
    }finally{busy=false;}
  }
  function locate(id){const job=records.find(j=>j.id===id);if(!job)throw Error('Unknown AI job.');if(job.localMode==='bundled')localHeaders(job);else if(job.provider!==config.provider||job.baseUrl!==config.baseUrl)throw Error('Reconnect the provider used for this job.');return job;}
  async function poll(id){
    const job=locate(id);if(TERMINAL.has(job.status)||!job.providerId)return publicJob(job);
    if(job.provider==='comfyui'){
      const result=await jsonAt(job,'/history/'+encodeURIComponent(job.providerId)),entry=result[job.providerId];
      if(!entry){const queue=await jsonAt(job,'/queue');job.status=queue.queue_running?.some(item=>item[1]===job.providerId)?'running':'queued';return publicJob(job);}
      if(entry.status?.status_str==='error'){job.status='failed';const detail=entry.status.messages?.find(m=>m[0]==='execution_error')?.[1];job.error=/out.of.memory/i.test(String(detail?.exception_type)+' '+String(detail?.exception_message))?'Not enough memory for this image. Try Small draft, close other GPU-heavy apps, or stop local AI and choose CPU mode.':'Local AI could not finish this image. View the local AI log for details, or try Small draft.';}
      else if(entry.status?.completed){job.outputs=Object.values(entry.outputs||{}).flatMap(o=>o.images||[]).filter(o=>typeof o.filename==='string').map(o=>({filename:o.filename,subfolder:o.subfolder||'',type:o.type||'output'}));job.status=job.outputs.length?'completed':'failed';if(!job.outputs.length)job.error='ComfyUI finished without an image output.';}
      else job.status='running';
    }else{
      const result=await jsonAt(job,'/v1/omni_api/job_status/job/'+encodeURIComponent(job.providerId),{auth:true});
      const state=result.state;if(!state?.status||typeof state.status.status!=='string')throw Error('Invalid ArtCraft job status.');
      const s=state.status.status;job.progress=state.status.progress_percentage;
      job.status=s==='complete_success'?'completed':['complete_failure','dead'].includes(s)?'failed':s.startsWith('cancelled')?'cancelled':s==='pending'?'queued':'running';
      if(job.status==='completed'){const url=state.maybe_result?.media_links?.cdn_url;if(typeof url!=='string')throw Error('Completed ArtCraft job has no media URL.');job.outputs=[{url}];}
      if(job.status==='failed')job.error='ArtCraft could not complete this job.';
    }
    job.updatedAt=new Date().toISOString();save();if(job.localMode==='bundled'&&job.status==='completed')await importResult(job.id);return publicJob(job);
  }
  async function importResult(id){
    const cached=records.find(j=>j.id===id);if(cached?.saved?.length){const files=cached.saved.map(item=>({...item,path:path.join(root,'results',path.basename(item.filename))}));if(files.every(item=>fs.existsSync(item.path)))return files;}
    const job=locate(id);if(job.status!=='completed'||!job.outputs?.length)throw Error('This job has no completed output yet.');
    const files=[];
    for(let index=0;index<job.outputs.length;index++){
      const output=job.outputs[index];let url;
      if(job.provider==='comfyui'){const q=new URLSearchParams({filename:output.filename,subfolder:output.subfolder,type:output.type});url=job.baseUrl+'/view?'+q;}
      else {const u=new URL(output.url),host=u.hostname;const local=LOOPBACK.has(new URL(job.baseUrl).hostname);if(!(u.protocol==='https:'&&['cdn-2.fakeyou.com','cdn.fakeyou.com'].includes(host))&&!(local&&u.origin===job.baseUrl))throw Error('ArtCraft returned a result outside its documented media hosts.');url=u.href;}
      // Deliberately no Authorization header on CDN media requests.
      const response=await fetchImpl(url,{headers:job.provider==='comfyui'?localHeaders(job):{},redirect:'error',signal:AbortSignal.timeout(45000)});
      if(!response.ok){await response.body?.cancel();throw Error(`Result download returned HTTP ${response.status}.`);}
      const bytes=await readLimited(response,MAX_MEDIA);let ext,mime;
      if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){ext='png';mime='image/png';}
      else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255){ext='jpg';mime='image/jpeg';}
      else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'){ext='webp';mime='image/webp';}
      else if(bytes.subarray(4,8).toString()==='ftyp'){ext='mp4';mime='video/mp4';}
      else throw Error('Provider result is not a supported PNG, JPEG, WebP, or MP4.');
      const filename=`${job.provider}-${job.id}-${index+1}.${ext}`,file=path.join(root,'results',filename);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
      files.push({path:file,filename,mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    job.saved=files.map(({path:ignored,...item})=>item);job.importedAt=new Date().toISOString();save();return files;
  }
  function endLocalJobs(){let changed=false;for(const job of records)if(job.localMode==='bundled'&&!TERMINAL.has(job.status)){job.status='cancelled';job.error='Local generation was stopped. Saved images are kept.';changed=true;}if(changed)save();}
  return {status,configure,connection,models,estimate,generate,jobs:()=>records.map(publicJob),poll,importResult,endLocalJobs};
}
module.exports={createAIProvider,normalizeConfig,buildComfyWorkflow,buildArtcraftRequest};
