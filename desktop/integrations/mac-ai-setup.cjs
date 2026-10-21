const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
let child=null,state={busy:false,message:''};
function status(){return {...state,canInstall:process.platform==='darwin'&&fs.existsSync(path.join(__dirname,'../local-ai/mac-setup.json'))};}
function install(options){
 if(options?.acceptLicense!==true)throw Error('Read and accept the SDXL model license before downloading local AI.');
 if(!status().canInstall)throw Error('The Mac local AI setup is not included in this package.');
 if(child)throw Error('Local AI setup is already running.');
 const python=require('../runtime-paths.cjs').python;
 child=spawn(python,['-I','-B','-u',path.join(__dirname,'../local-ai/setup_mac.py')],{shell:false,stdio:['ignore','pipe','pipe']});
 state={busy:true,message:'Preparing local AI setup…'};let error='';
 child.stdout.on('data',b=>{state.message=String(b).trim().split('\n').at(-1).slice(0,500);});
 child.stderr.on('data',b=>{error=(error+String(b)).slice(-3000);});
 child.on('error',e=>{state={busy:false,message:e.message};child=null;});
 child.on('close',code=>{state={busy:false,message:code===0?'Local AI installed. Choose Start local AI.':error.trim().split('\n').at(-1)||'Setup stopped. Try again.'};child=null;});
 return status();
}
function cancel(){child?.kill();}
module.exports={status,install,cancel};
