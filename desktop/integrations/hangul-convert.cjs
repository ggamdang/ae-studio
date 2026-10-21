'use strict';
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path');
const {spawn,execFile}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {assertLocalPath}=require('../file-routing.cjs');
const runtime=path.join(__dirname,'../hangul-runtime');
const executable=require('../runtime-paths.cjs').hangul;
function available(){return sync.existsSync(executable);}
async function convertHangul(source,outputRoot){
  source=assertLocalPath(source);const extension=path.extname(source).toLowerCase();
  if(!['.hwp','.hwpx'].includes(extension))throw Error('Choose an HWP or HWPX document.');
  if(!available())throw Error('The bundled Hangul importer is missing. Repair AE Studio using its installer.');
  const pinned=JSON.parse(await fs.readFile(path.join(runtime,'manifest.json'),'utf8'));
  if(createHash('sha256').update(await fs.readFile(executable)).digest('hex')!==pinned.executableSha256)throw Error('The Hangul importer failed its integrity check. Repair AE Studio.');
  const stat=await fs.stat(source);if(!stat.isFile()||stat.size<1||stat.size>1024**3)throw Error('Choose a readable Hangul document up to 1 GB.');
  await fs.mkdir(outputRoot,{recursive:true});
  const job=await fs.mkdtemp(path.join(outputRoot,'Hangul-'));
  const staged=path.join(job,'source'+extension),destination=path.join(job,path.parse(source).name+'.docx');
  try{
    // Use a private local copy so the source is never edited and network drops
    // cannot leave a partly read HWP file in the converter.
    await fs.copyFile(source,staged);
    const after=await fs.stat(source);
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('This file changed while opening. Choose it again.');
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,['convert',staged,'--output',destination],{cwd:job,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      let done=false,output=0;
      const finish=e=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve();};
      const stop=()=>{if(process.platform==='win32'&&child.pid)execFile(path.join(process.env.SystemRoot||'C:/Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});else child.kill();};
      const timer=setTimeout(()=>{stop();finish(Error('Hangul import exceeded ten minutes. The original was not changed.'));},600000);
      for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output+=bytes.length;if(output>1024**2){stop();finish(Error('The Hangul importer returned too much output.'));}});
      child.on('error',()=>finish(Error('The Hangul importer could not start.')));
      child.on('close',code=>finish(code===0?null:Error('This HWP/HWPX file could not be imported. It may be password protected, damaged, an old HWP version, or use unsupported features. Save an unprotected DOCX copy in Hancom and try again.')));
    });
    const result=await fs.stat(destination).catch(()=>null);
    if(!result?.isFile()||!result.size)throw Error('Hangul import did not produce a readable DOCX copy.');
    return destination;
  }finally{
    // Delete only the fixed staging copy within the fresh job, never the source.
    await fs.unlink(staged).catch(()=>{});
  }
}
module.exports={available,convertHangul};
