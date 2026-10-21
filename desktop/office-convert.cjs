'use strict';
const fs=require('node:fs/promises');
const sync=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn,execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const os=require('node:os');
const executable=require('./runtime-paths.cjs').office;
const filters={docx:'Office Open XML Text',xlsx:'Calc MS Excel 2007 XML',pptx:'Impress MS PowerPoint 2007 XML',pdf:'',doc:'MS Word 97',xls:'MS Excel 97',ppt:'MS PowerPoint 97'};
function available(){return sync.existsSync(executable);}
async function convertOffice(source,target,outputRoot){
  if(!available())throw Error('The bundled LibreOffice converter is missing. Re-extract the complete application folder.');
  if(!Object.hasOwn(filters,target))throw Error('Unsupported Office conversion.');
  if(!path.isAbsolute(source)||(await fs.stat(source)).isFile()!==true)throw Error('Choose a local Office document.');
  const job=path.join(outputRoot,'Office-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  const staging=await fs.mkdtemp(path.join(os.tmpdir(),'us-office-'));
  try{
  const profile=path.join(staging,'profile'),out=path.join(staging,'out');
  const stagedSource=path.join(staging,'input'+path.extname(source).toLowerCase());
  await fs.copyFile(source,stagedSource);
  await fs.mkdir(path.join(profile,'user'),{recursive:true});await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(profile,'user','registrymodifications.xcu'),'<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>');
  const args=['-env:UserInstallation='+pathToFileURL(profile).href,'--headless','--nologo','--nodefault','--norestore','--nofirststartwizard','--convert-to',target+(filters[target]?':'+filters[target]:''),'--outdir',out,stagedSource];
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let output=0,done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
    const stop=()=>{if(process.platform==='win32'&&child.pid)execFile(path.join(process.env.SystemRoot||'C:/Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});else child.kill();};
    const timer=setTimeout(()=>{stop();finish(Error('Office conversion exceeded ten minutes. The original file was not changed.'));},600000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output+=bytes.length;if(output>1024*1024){stop();finish(Error('Office conversion returned too much output.'));}});
    child.on('error',()=>finish(Error('The Office converter could not start.')));child.on('close',code=>finish(code===0?null:Error('LibreOffice could not convert this document. It may be damaged, encrypted, or unsupported.')));
  });
  const expected=path.join(out,'input.'+target);const stat=await fs.stat(expected).catch(()=>null);
  if(!stat?.isFile()||stat.size===0)throw Error('Office conversion did not produce a readable file. The document may be password protected.');
  await fs.mkdir(job,{recursive:true});
  const destination=path.join(job,path.parse(source).name+'.'+target);
  await fs.copyFile(expected,destination,require('node:fs').constants.COPYFILE_EXCL);
  return destination;
  }finally{
    // Remove only our unique temporary staging folder, after checking its real parent.
    const actual=await fs.realpath(staging),parent=await fs.realpath(os.tmpdir());
    if(path.dirname(actual)===parent&&path.basename(actual).startsWith('us-office-'))await fs.rm(actual,{recursive:true,force:true}).catch(()=>{});
  }
}
module.exports={available,convertOffice};
