'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
async function convertRaster(file,outputRoot){
  const folder=path.join(outputRoot,'Image-'+randomUUID());await fs.mkdir(folder,{recursive:true});const destination=path.join(folder,path.parse(file.path).name+'.png');
  await new Promise((resolve,reject)=>{const child=spawn(require('../runtime-paths.cjs').python,[path.join(__dirname,'raster-convert.py'),file.path,destination],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});let output='',done=false;const finish=e=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve();};const timer=setTimeout(()=>{child.kill();finish(Error('Image conversion timed out.'));},60000);child.stdout.on('data',b=>{if(output.length<16384)output+=b;});child.on('error',()=>finish(Error('The bundled image converter is unavailable.')));child.on('close',code=>{let result;try{result=JSON.parse(output);}catch{}finish(code===0&&result?.ok?null:Error('Image conversion failed. This import supports the first frame of AVIF images up to 60 million pixels.'));});});return destination;
}
module.exports={convertRaster};
