const path=require('node:path');
function resolveAsset(root, pathname) {
  let decoded;
  try {decoded=decodeURIComponent(pathname);} catch {return null;}
  if(decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) return null;
  const target=path.resolve(root,'.'+(decoded==='/'?'/index.html':decoded));
  return target.startsWith(path.resolve(root)+path.sep) ? target : null;
}
function validModule(id, modules) {return typeof id==='string' && modules.some(m=>m.id===id);}
function safeFilename(name) {let file=path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'');if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file))file='_'+file;if(file.length>180){const ext=path.extname(file).slice(0,20);file=Array.from(path.parse(file).name).slice(0,140).join('')+ext;}return file||'export';}
module.exports={resolveAsset,validModule,safeFilename};
