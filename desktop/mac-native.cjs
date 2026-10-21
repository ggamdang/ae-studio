'use strict';
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process');
const catalog=require('./native-apps.json');
const {assertLocalPath}=require('./file-routing.cjs');
const bundleRoot=process.env.AE_NATIVE_ROOT||path.resolve(__dirname,'../../../..');
const officeCopies={ppt:'pptx',pps:'pptx',pot:'pptx',pptm:'pptx',ppsm:'pptx',potm:'pptx',odp:'pptx',otp:'pptx',fodp:'pptx',ott:'docx',fodt:'docx',wps:'docx',xlt:'xlsx',xltx:'xlsx',xltm:'xlsx',ots:'xlsx',fods:'xlsx'};
const native=id=>catalog.find(m=>m.id===id);
function appPath(id){const m=native(id);if(!m)throw Error('Unknown native editor.');return path.join(bundleRoot,'Apps',m.bundleName);}
function installed(id){return !!native(id)&&sync.existsSync(appPath(id));}
function route(filename){const ext=path.extname(filename).slice(1).toLowerCase();if(['hwp','hwpx'].includes(ext))return {id:'wordcraft',convert:'hangul'};if(officeCopies[ext])return {id:officeCopies[ext]==='pptx'?'deckcraft':officeCopies[ext]==='xlsx'?'gridcraft':'wordcraft',convert:officeCopies[ext]};const m=catalog.find(m=>m.extensions.includes(ext));return m?{id:m.id}:null;}
async function launch(id,filename){
  const bundle=appPath(id);if(!installed(id))throw Error('This editor is missing. Reinstall the complete AE Studio package.');
  if(filename){filename=assertLocalPath(filename);const s=await fs.stat(filename);if(!s.isFile())throw Error('Choose a regular document file.');}
  // Argument array preserves spaces, Korean names, mounted volumes and metacharacters.
  await new Promise((resolve,reject)=>execFile('/usr/bin/open',['-a',bundle,...(filename?[filename]:[])],{timeout:20000},error=>error?reject(Error('macOS could not open this editor. Open it from Applications and check any macOS permission message.')):resolve()));
  return {editor:id,name:filename?path.basename(filename):native(id).name,delivered:true};
}
async function openFile(filename,dataDir){const r=route(filename);if(!r)return null;assertLocalPath(filename);const s=await fs.stat(filename);if(!s.isFile())throw Error('Choose a regular document file.');let converted=filename;
  if(r.convert==='hangul')converted=await require('./integrations/hangul-convert.cjs').convertHangul(filename,path.join(dataDir,'Converted'));
  else if(r.convert)converted=await require('./office-convert.cjs').convertOffice(filename,r.convert,path.join(dataDir,'Converted'));
  return launch(r.id,converted);
}
function formats(){return catalog.flatMap(m=>m.extensions.map(extension=>({extension,workspace:m.name,open:'Native import',edit:'Depends on the format',exports:'Use the original editor’s Export menu',notes:m.notes,verification:'Representative Mac tests; not every format or feature is certified.'}))).concat(Object.entries(officeCopies).map(([extension,target])=>({extension,workspace:'Office conversion',open:'Create a new '+target.toUpperCase()+' copy',edit:'Edit the converted copy',exports:target.toUpperCase(),notes:'Original preserved. Layout, fonts and unsupported features can differ.',verification:'Conversion requires the bundled LibreOffice runtime.'})),['hwp','hwpx'].map(extension=>({extension,workspace:'WordCraft',open:'Import as a DOCX copy',edit:'Edit the converted copy',exports:'DOCX',notes:'HWP/HWPX are not edited in place. Password-protected and unsupported Hangul features may fail.',verification:'hwp-cli importer; verify important formatting.'})));}
const nativeFormats=formats;
module.exports={catalog,native,route,installed,launch,openFile,formats:()=>nativeFormats().concat(['artcraft','glb'].map(extension=>({extension,workspace:'ArtCraft',open:'Local project / 3D import',edit:'Scene editing',exports:'Use ArtCraft save and export',notes:'Hosted ArtCraft services are not bundled.',verification:'Local workspace; advanced assets can require more memory.'})))};
