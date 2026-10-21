const fs=require('node:fs/promises');
const path=require('node:path');

// Explicitly routed formats from the pinned editors. A route is an import attempt,
// not a fidelity claim; optional native codecs are deliberately excluded.
const groups=Object.freeze([
  {name:'Documents',editor:'wordcraft',extensions:['docx','odt','rtf','txt','md','html','htm','tex'],limitMiB:128},
  {name:'Spreadsheets',editor:'gridcraft',extensions:['xlsx','ods','csv','tsv'],limitMiB:128},
  {name:'Presentations',editor:'deckcraft',extensions:['pptx','deckcraft'],limitMiB:128},
  {name:'PDF documents',editor:'pdfcraft',extensions:['pdf'],limitMiB:256},
  {name:'Images',editor:'photocraft',extensions:['psd','psb','psdt','pcraft','pdn','png','jpg','jpeg','tif','tiff','webp','gif','bmp','tga','ico','qoi','pnm','ppm','pgm','pbm','pam','pfm','exr','hdr','fits','fit','fts','avif','ora','kra','afphoto'],limitMiB:256},
  {name:'Image presets',editor:'photocraft',extensions:['abr','grd','aco','ase'],limitMiB:128},
  {name:'Vector artwork',editor:'vectorcraft',extensions:['svg','svgz','vectorcraft','vctemplate','ai','ait','eps','dxf','emf','wmf','af','afdesign','afpub'],limitMiB:128},
  {name:'Camera RAW photos',editor:'lightcraft',extensions:['dng','cr2','cr3','nef','nrw','arw','raf','rw2','rwl','pef','orf','jxl'],limitMiB:256,action:'light-import'},
  {name:'Page layouts',editor:'designcraft',extensions:['designcraft','idml'],limitMiB:128},
  {name:'ArtCraft projects and models',editor:'artcraft',extensions:['artcraft','glb'],limitMiB:256,action:'artcraft-import'},
  {name:'Video and audio',editor:'filmcraft',extensions:['mp4','mov','m4v','webm','mkv','avi','mpg','mpeg','wav','mp3','m4a','aac','flac','ogg','opus'],limitMiB:512,action:'film-import'},
  {name:'Video projects',editor:'filmcraft',extensions:['fcproj'],limitMiB:128,action:'film-project'},
  {name:'Motion projects',editor:'effectcraft',extensions:['ecproj'],limitMiB:128},
]);
const legacy=Object.freeze({hwp:'DOCX',hwpx:'DOCX',doc:'DOCX',dot:'DOCX',docm:'DOCX',dotx:'DOCX',dotm:'DOCX',ott:'DOCX',fodt:'DOCX',wps:'DOCX',xls:'XLSX',xlsb:'XLSX',xlsm:'XLSX',xlt:'XLSX',xltx:'XLSX',xltm:'XLSX',ots:'XLSX',fods:'XLSX',ppt:'PPTX',pps:'PPTX',pot:'PPTX',pptm:'PPTX',ppsx:'PPTX',ppsm:'PPTX',potx:'PPTX',potm:'PPTX',odp:'PPTX',otp:'PPTX',fodp:'PPTX'});
const MAX_FILES=8;
const MAX_BATCH_BYTES=768*1024*1024;
function routeFile(filename){
  const extension=path.extname(filename).slice(1).toLowerCase();
  if(legacy[extension])return {supported:false,extension,targetExtension:legacy[extension].toLowerCase(),maxBytes:128*1024*1024,code:'LEGACY_CONVERSION',message:`This .${extension} format needs conversion before editing. If the local converter is unavailable, in the application that created it or LibreOffice use Save As to create a .${legacy[extension].toLowerCase()} copy, then open that copy here. Renaming the extension does not convert a file.`};
  const group=groups.find(g=>g.extensions.includes(extension));
  if(!group)return {supported:false,extension,code:'UNSUPPORTED_FORMAT',message:`${extension?'.'+extension:'This file type'} is not supported by the shared Open command. Export a supported format from the original application.`};
  return {supported:true,extension,editor:group.editor,action:group.action||'open',maxBytes:group.limitMiB*1024*1024};
}
// Local disks, removable disks, mapped drives and ordinary UNC shares are files.
// Device namespaces, named pipes and alternate streams are not document paths.
function assertLocalPath(filename,platform=process.platform){
  if(typeof filename!=='string'||!filename||filename.length>=32760||/[\x00-\x1f]/.test(filename))throw new Error('The file path is invalid or too long.');
  if(platform!=='win32'){
    if(!path.isAbsolute(filename))throw new Error('Choose a file using Open or drag it from File Explorer.');
    return filename;
  }
  let value=filename.replaceAll('/','\\');
  if(/^\\\\\?\\UNC\\/i.test(value))value='\\\\'+value.slice(8);
  else if(/^\\\\\?\\[a-z]:\\/i.test(value))value=value.slice(4);
  const drive=/^[a-z]:\\/i.test(value);
  const unc=/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value)&&!/^\\\\[?.]\\/.test(value);
  if(!drive&&!unc)throw new Error('Choose an absolute drive path or a network share such as \\\\server\\share\\file. Device paths are not document files.');
  const tail=drive?value.slice(3):value.slice(2);
  if(/[<>:"|?*]/.test(tail))throw new Error('Alternate streams, wildcards and device paths are not document files.');
  const pieces=tail.split('\\');
  if(pieces.some(p=>/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\.|$)/i.test(p))||unc&&/^(IPC\$|PIPE)$/i.test(pieces[1]))throw new Error('Device names and named pipes are not document files.');
  return path.win32.normalize(value);
}
async function validateFile(filename,{allowLegacy=false,allowLarge=false,memoryBytes=require('node:os').totalmem()}={}){
  filename=assertLocalPath(filename);
  let actual,stat;
  try{actual=assertLocalPath(await fs.realpath(filename));stat=await fs.stat(actual);}catch(e){if(e.code==='ENOENT')throw new Error('The file or drive is unavailable. Reconnect the drive or network share, then choose the file again.');if(e.code==='EACCES'||e.code==='EPERM')throw new Error('The selected file cannot be read. Check your file or network-share permissions in File Explorer.');if(['EIO','ENOTCONN','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT'].includes(e.code))throw new Error('The drive or network share is unavailable. Reconnect it in File Explorer and try again.');throw e;}
  if(!stat.isFile())throw new Error('Choose a regular file. Folders and special files cannot be opened.');
  const route=routeFile(actual);
  if(!route.supported&&!(allowLegacy&&route.code==='LEGACY_CONVERSION')){const error=new Error(route.message);error.code=route.code;throw error;}
  const streaming=route.action==='film-import'&&['mp4','mov','m4v','webm','mkv'].includes(route.extension);
  const nativePDF=route.extension==='pdf'&&stat.size>route.maxBytes;
  const hardMax=route.extension==='pdf'?2*1024**3:streaming?50*1024**3:Math.max(route.maxBytes,Math.min(1024**3,Math.floor(memoryBytes/8)));
  if(stat.size>(allowLarge?hardMax:route.maxBytes))throw new Error(`This .${route.extension} file exceeds the ${Math.round((allowLarge?hardMax:route.maxBytes)/1024**2)} MB opening limit. Large video can use up to 50 GB; other editors still need memory for a complete decoded document. Split or convert a copy for larger files.`);
  await fs.access(actual,require('node:fs').constants.R_OK);
  return {path:actual,name:path.basename(actual),size:stat.size,mtimeMs:stat.mtimeMs,...route,...(nativePDF?{editor:'pdf-tools',action:'pdf-tools'}:{}),large:stat.size>route.maxBytes,hardMax,streaming,nativePDF};
}
function validateBatch(paths){
  if(!Array.isArray(paths)||paths.length<1||paths.length>MAX_FILES||paths.some(p=>typeof p!=='string'))throw new Error(`Choose between one and ${MAX_FILES} files at a time.`);
  return [...new Set(paths)];
}
function fileArguments(argv,{defaultApp=false,cwd=process.cwd()}={}){
  // Electron development launches include the app path; packaged launches do not.
  const args=argv.slice(defaultApp?2:1);const files=[];let literal=false;
  for(const arg of args){
    if(arg==='--'){literal=true;continue;}
    if(!literal&&arg.startsWith('-'))continue;
    if(typeof arg!=='string'||/^[a-z][a-z\d+.-]*:\/\//i.test(arg))continue;
    files.push(path.resolve(cwd,arg));
  }
  return files;
}
function dialogFilters(){return [{name:'Supported files (Office and Hangul conversion included)',extensions:[...groups.flatMap(g=>g.extensions),...Object.keys(legacy)]},...groups.map(({name,extensions})=>({name,extensions})),{name:'Office and Hangul — convert to a modern copy',extensions:Object.keys(legacy)},{name:'All files',extensions:['*']}];}
function publicCapabilities(){return {maxFiles:MAX_FILES,formats:[...groups.map(({name,editor,extensions,limitMiB})=>({name,editor,extensions,limitMiB})),{name:'Office and Hangul (conversion required)',editor:'conversion',extensions:Object.keys(legacy),limitMiB:128}],legacy:Object.keys(legacy),legacyStatus:'Legacy Office files open through local conversion when the converter is available; otherwise save a modern copy in the original application.'};}
module.exports={groups,legacy,MAX_FILES,MAX_BATCH_BYTES,routeFile,assertLocalPath,validateFile,validateBatch,fileArguments,dialogFilters,publicCapabilities};

