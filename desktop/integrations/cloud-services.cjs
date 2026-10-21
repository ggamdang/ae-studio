'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {safeFilename}=require('../core.cjs');
const {jsonResponse}=require('./accounts.cjs');
const MAX_TRANSFER=50*1024**3;
function deadline(signal,ms){const timeout=AbortSignal.timeout(ms);return signal?AbortSignal.any([signal,timeout]):timeout;}
function promptText(value){if(typeof value!=='string'||!value.trim()||value.length>32000)throw Error('Enter a prompt of 1–32,000 characters.');return value.trim();}
async function readResponseStream(response){
  if(!response.ok){await response.body?.cancel();throw Error(`ChatGPT returned HTTP ${response.status}. Check your account and usage limits. No retry or paid fallback was made.`);}
  if(!response.headers.get('content-type')?.startsWith('text/event-stream')){await response.body?.cancel();throw Error('ChatGPT did not return the expected response stream.');}
  const decoder=new TextDecoder();let pending='',answer='',completed=false,bytes=0;
  function event(block){
    const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return;
    const e=JSON.parse(data);
    if(['response.failed','response.incomplete','error'].includes(e.type))throw Error('ChatGPT did not complete this answer. Check your plan usage or try again yourself; AE Studio has not retried.');
    if(e.type==='response.output_text.delta'&&typeof e.delta==='string')answer+=e.delta;
    if(e.type==='response.refusal.delta'&&typeof e.delta==='string')answer+=e.delta;
    if(e.type==='response.completed'){if(e.response?.status&&e.response.status!=='completed')throw Error('ChatGPT did not complete this answer.');completed=true;}
  }
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>8*1024**2)throw Error('The answer exceeded the response limit.');pending+=decoder.decode(chunk,{stream:true});let boundary;while((boundary=/\r?\n\r?\n/.exec(pending))){event(pending.slice(0,boundary.index));pending=pending.slice(boundary.index+boundary[0].length);}}
  pending+=decoder.decode();if(pending.trim())event(pending);if(!completed)throw Error('The connection ended before ChatGPT completed its answer. No automatic retry was made.');return answer||'The model completed without a text answer.';
}
function createCloudServices({accounts,downloadRoot,onDownload=()=>{}}){
  const modelLists=new Map();
  async function headers(id,provider){accounts.account(id,provider);return {Authorization:'Bearer '+await accounts.access(id)};}
  async function models(id){const result=await accounts.request('https://api.openai.com/v1/models',{headers:await headers(id,'chatgpt')});if(!Array.isArray(result.models))throw Error('The ChatGPT model list is unavailable.');const list=result.models.filter(m=>m.visibility==='list'&&typeof m.slug==='string'&&typeof m.display_name==='string').map(m=>({id:m.slug,name:m.display_name}));modelLists.set(id,list);return list;}
  async function chatgpt(id,model,prompt,signal){
    const input=promptText(prompt),a=accounts.account(id,'chatgpt');if(!a.scopes?.includes('chatgpt.tokens.use.direct'))throw Error('Authorize ChatGPT plan use when signing in.');
    const list=modelLists.get(id)||await models(id);if(!list.some(m=>m.id===model))throw Error('Choose a model from this account’s current model list.');
    const response=await accounts.fetchImpl('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',headers:{...await headers(id,'chatgpt'),'Content-Type':'application/json'},signal:deadline(signal,300000),body:JSON.stringify({model,input:[{role:'user',content:input}],instructions:'You are the AE Studio writing assistant. Answer the user using text. You have no access to their files, computer, or tools.',store:false,stream:true})});
    return readResponseStream(response);
  }
  async function driveList(id){
    const result=await accounts.request('https://www.googleapis.com/drive/v3/files?'+new URLSearchParams({q:"trashed = false and mimeType != 'application/vnd.google-apps.folder'",pageSize:'100',orderBy:'modifiedTime desc',fields:'files(id,name,mimeType,size,modifiedTime),nextPageToken'}),{headers:await headers(id,'google')});
    return {files:(result.files||[]).map(f=>({id:f.id,name:f.name,mimeType:f.mimeType,size:f.size||null,modifiedTime:f.modifiedTime})),more:!!result.nextPageToken};
  }
  async function driveUpload(id,filename,signal){
    const input=await fs.open(filename,'r');try{
      const stat=await input.stat();if(!stat.isFile()||!stat.size||stat.size>MAX_TRANSFER)throw Error('Choose a non-empty local file up to 50 GB.');
      const auth=await headers(id,'google');
      const start=await accounts.fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size',{method:'POST',redirect:'error',signal:deadline(signal,30000),headers:{...auth,'Content-Type':'application/json','X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(stat.size)},body:JSON.stringify({name:path.basename(filename),description:'Uploaded as a new copy by AE Studio'})});
      if(!start.ok){await start.body?.cancel();throw Error('Drive could not start the upload. Check storage space and account permissions.');}
      const location=new URL(start.headers.get('location'));await start.body?.cancel();
      if(location.origin!=='https://www.googleapis.com'||location.username||location.password||!location.pathname.startsWith('/upload/drive/'))throw Error('Drive returned an unexpected upload destination.');
      const chunkSize=8*1024**2;let position=0,result;
      while(position<stat.size){
        const chunk=Buffer.allocUnsafe(Math.min(chunkSize,stat.size-position));let read=0;while(read<chunk.length){const r=await input.read(chunk,read,chunk.length-read,position+read);if(!r.bytesRead)throw Error('The file changed while uploading.');read+=r.bytesRead;}
        const end=position+chunk.length-1;
        const response=await accounts.fetchImpl(location.href,{method:'PUT',redirect:'manual',signal:deadline(signal,120000),headers:{...await headers(id,'google'),'Content-Type':'application/octet-stream','Content-Length':String(chunk.length),'Content-Range':`bytes ${position}-${end}/${stat.size}`},body:chunk});
        if(end+1===stat.size){result=await jsonResponse(response);break;}
        if(response.status!==308||response.headers.get('range')!==`bytes=0-${end}`){await response.body?.cancel();throw Error('Drive upload stopped before completion. No existing Drive file was replaced.');}
        await response.body?.cancel();position=end+1;
      }
      return {id:result.id,name:result.name};
    }finally{await input.close();}
  }
  async function driveDownload(id,fileId,signal){
    if(typeof fileId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(fileId))throw Error('Choose a Drive file.');
    const auth=await headers(id,'google'),base='https://www.googleapis.com/drive/v3/files/'+fileId;
    const info=await accounts.request(base+'?fields=id,name,mimeType,size',{headers:auth});
    const conversions={'application/vnd.google-apps.document':['application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],'application/vnd.google-apps.spreadsheet':['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx'],'application/vnd.google-apps.presentation':['application/vnd.openxmlformats-officedocument.presentationml.presentation','.pptx']};
    const conversion=conversions[info.mimeType];if(!conversion&&info.mimeType?.startsWith('application/vnd.google-apps.'))throw Error('This Google file cannot be exported here. Use Google Drive to download a supported copy.');
    if(Number(info.size)>MAX_TRANSFER)throw Error('This file exceeds the 50 GB download limit.');
    const url=conversion?base+'/export?'+new URLSearchParams({mimeType:conversion[0]}):base+'?alt=media';
    const response=await accounts.fetchImpl(url,{headers:auth,redirect:'error',signal:deadline(signal,600000)});
    if(!response.ok){await response.body?.cancel();throw Error(`Drive could not download this file (HTTP ${response.status}). Large Google Docs exports may need downloading from Drive directly.`);}
    const folder=path.join(downloadRoot,crypto.randomUUID());await fs.mkdir(folder,{recursive:true});let name=safeFilename(info.name||'Drive file');if(conversion&&!name.toLowerCase().endsWith(conversion[1]))name+=conversion[1];
    const destination=path.join(folder,name);const out=await fs.open(destination,'wx');let bytes=0,done=false;
    try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>MAX_TRANSFER)throw Error('Download exceeded 50 GB.');let offset=0;while(offset<chunk.length){const write=await out.write(chunk,offset,chunk.length-offset);if(!write.bytesWritten)throw Error('The disk could not save the download.');offset+=write.bytesWritten;}}if(!bytes||!conversion&&info.size&&bytes!==Number(info.size))throw Error('Drive returned an incomplete file.');done=true;}finally{await out.close();if(!done)await fs.unlink(destination).catch(()=>{});}
    onDownload({id:crypto.randomUUID(),name,path:destination,module:'Google Drive'});return {path:destination,name,bytes,converted:!!conversion};
  }
  return {models,chatgpt,driveList,driveUpload,driveDownload};
}
module.exports={createCloudServices,readResponseStream,promptText,MAX_TRANSFER};
