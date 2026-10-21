'use strict';
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const MAX_INPUT=32*1024*1024,MAX_OUTPUT=Math.ceil(32*1024*1024/3)*4+4096;

function createBackgroundTool({ipcMain,views,spawnImpl=spawn}){
  let running=null;
  function cancel(){running?.abort();}
  ipcMain.handle('studio:artcraft-remove-background',async(event,imageBase64)=>{
    const contents=views.get('artcraft')?.webContents;
    if(!contents||event.sender!==contents||event.senderFrame!==contents.mainFrame||event.senderFrame.url!=='studio://artcraft/index.html')throw Error('Untrusted background removal request.');
    if(running)throw Error('Background removal is already running.');
    if(typeof imageBase64!=='string'||!imageBase64.length||imageBase64.length>Math.ceil(MAX_INPUT/3)*4||imageBase64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64))throw Error('Choose an image no larger than 32 MB.');
    const runtime=require('../runtime-paths.cjs').python,script=path.join(__dirname,'background','remove.py');
    if(!fs.existsSync(runtime)||!fs.existsSync(script))throw Error('The local background removal runtime is missing. Re-extract the complete app.');
    const controller=new AbortController();running=controller;
    const gone=()=>controller.abort();contents.once('destroyed',gone);
    try{return await new Promise((resolve,reject)=>{
      let child,done=false,output='',stderrBytes=0;
      const temp=fs.mkdtempSync(path.join(os.tmpdir(),'us-background-'));
      const cleanup=()=>{
        const absolute=path.resolve(temp);
        if(path.dirname(absolute)===path.resolve(os.tmpdir())&&path.basename(absolute).startsWith('us-background-'))fs.promises.rm(absolute,{recursive:true,force:true,maxRetries:4,retryDelay:150}).catch(()=>{});
      };
      const stop=()=>{if(!child?.pid)return;if(process.platform!=='win32'){child.kill();return;}const killer=spawnImpl(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});killer.on('error',()=>child.kill());};
      const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);error?reject(error):resolve(result);};
      const abort=()=>{stop();finish(Error('Background removal was cancelled.'));};
      const timer=setTimeout(()=>{stop();finish(Error('Background removal exceeded its three-minute limit. Try a smaller image.'));},180000);
      controller.signal.addEventListener('abort',abort,{once:true});
      try{
        child=spawnImpl(runtime,['-I','-B',script],{cwd:ROOT,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{HOME:os.homedir(),TMPDIR:temp,LANG:'en_US.UTF-8',SystemRoot:process.env.SystemRoot||'C:\\Windows',WINDIR:process.env.WINDIR||'C:\\Windows',PATH:path.dirname(runtime),TEMP:temp,TMP:temp,OMP_NUM_THREADS:'4'}});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data',chunk=>{output+=chunk;if(output.length>MAX_OUTPUT){stop();finish(Error('The resulting image is too large. Try a smaller image.'));}});
        child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>1024*1024){stop();finish(Error('The local image engine could not finish.'));}});
        child.on('error',()=>{cleanup();finish(Error('The local image engine could not start.'));});
        child.on('close',code=>{
          cleanup();if(done)return;
          try{
            const result=JSON.parse(output);
            if(result.ok!==true||code!==0)throw Error(result.error?.message||'The local image engine could not finish.');
            if(typeof result.pngBase64!=='string'||!result.pngBase64.startsWith('iVBORw0KGgo')||result.pngBase64.length>MAX_OUTPUT)throw Error('The local image engine returned an invalid image.');
            finish(null,{ok:true,pngBase64:result.pngBase64});
          }catch(error){finish(error instanceof SyntaxError?Error('The local image engine returned an invalid result.'):error);}
        });
        child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({imageBase64}),'utf8');imageBase64='';
      }catch{cleanup();finish(Error('The local image engine could not start.'));}
    });}finally{contents.removeListener('destroyed',gone);running=null;}
  });
  return {cancel};
}
module.exports={createBackgroundTool};
