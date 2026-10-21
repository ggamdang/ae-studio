const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const {unzipSync}=require('fflate');
function verifyArchive(data,expected){if(crypto.createHash('sha256').update(data).digest('hex')!==expected)throw new Error('The editor download failed its integrity check.');}
async function extractArchive(data,destination){
  let expanded=0;
  const files=unzipSync(data,{filter:entry=>{expanded+=entry.originalSize;if(expanded>800*1024*1024)throw new Error('Archive exceeds the extraction limit');return true;}});
  const entries=Object.entries(files);if(entries.length>20000)throw new Error('Too many archive entries');
  const roots=new Set(entries.map(([name])=>name.split('/')[0]));if(roots.size!==1)throw new Error('Unexpected archive layout');
  const validated=[];
  for(const [name,bytes] of entries){
    if(name.includes('\\')||name.includes(':')||name.includes('\0')||name.split('/').some(p=>p==='..'))throw new Error('Unsafe archive entry');
    const relative=name.split('/').slice(1).join('/');if(!relative||name.endsWith('/'))continue;
    const target=path.resolve(destination,relative);if(!target.startsWith(path.resolve(destination)+path.sep))throw new Error('Archive entry escapes the editor directory');
    validated.push([target,bytes]);
  }
  if(!validated.some(([name])=>name===path.join(path.resolve(destination),'index.html')))throw new Error('The editor has no entry page');
  await fs.mkdir(destination,{recursive:true});
  for(const [target,bytes] of validated){await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
}
async function installEditors(locks,root,onProgress){
  await fs.mkdir(root,{recursive:true});
  for(let i=0;i<locks.length;i++){
    const entry=locks[i];if(!/^[a-z-]+$/.test(entry.id)||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Invalid editor manifest');
    const dest=path.join(root,entry.id);if(await fs.stat(path.join(dest,'index.html')).then(()=>true).catch(()=>false))continue;
    onProgress(`Downloading ${entry.id} (${i+1} of ${locks.length})…`);
    const expectedPrefix=`https://github.com/storytold/${entry.id}/releases/tag/`;
    if(!entry.release.startsWith(expectedPrefix)||!/^[a-z0-9.-]+\.zip$/i.test(entry.archive))throw new Error('Unexpected editor source');
    const url=entry.release.replace('/releases/tag/','/releases/download/')+'/'+entry.archive;
    const response=await fetch(url,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw new Error(`Download failed (${response.status}). Try setup again.`);
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>160*1024*1024)throw new Error('Editor download is too large');chunks.push(chunk);}
    const data=Buffer.concat(chunks);verifyArchive(data,entry.sha256);
    onProgress(`Installing ${entry.id} (${i+1} of ${locks.length})…`);
    const stage=path.join(root,`.setup-${entry.id}-${crypto.randomUUID()}`);
    // A new staging directory prevents incomplete extraction from appearing installed.
    await extractArchive(data,stage);await fs.rename(stage,dest);
  }
  onProgress('Setup complete. Your editors are ready.');
}
module.exports={verifyArchive,extractArchive,installEditors};
