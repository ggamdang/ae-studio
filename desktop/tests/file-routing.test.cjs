const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {routeFile,assertLocalPath,validateFile,validateBatch,fileArguments,dialogFilters}=require('../file-routing.cjs');
test('modern files route to the correct original editor; legacy is actionable',()=>{
  for(const [file,id] of [['문서.DOCX','wordcraft'],['Budget.xlsx','gridcraft'],['Slides.pptx','deckcraft'],['pages.pdf','pdfcraft'],['photo.PNG','photocraft'],['logo.svg','vectorcraft'],['shot.nef','lightcraft'],['layout.idml','designcraft'],['clip.mp4','filmcraft'],['sound.wav','filmcraft']])assert.equal(routeFile(file).editor,id,file);
  for(const ext of ['doc','xls','ppt']){const r=routeFile('a.'+ext);assert.equal(r.supported,false);assert.equal(r.code,'LEGACY_CONVERSION');assert.match(r.message,/Save As/);assert.match(r.message,/Renaming/);}
  for(const file of ['bad.exe','file','archive.zip','macro.docm','web.url'])assert.equal(routeFile(file).supported,false);
  const filters=dialogFilters();assert.ok(filters[0].extensions.includes('docx'));assert.equal(filters[0].extensions.includes('doc'),true);assert.ok(filters.some(f=>/convert/i.test(f.name)&&f.extensions.includes('ppt')));assert.equal(routeFile('motion.ecproj').editor,'effectcraft');
});
test('Windows paths accept ordinary drives and UNC shares but reject device namespaces and streams',()=>{
  assert.equal(assertLocalPath('D:\\Work\\문서.docx','win32'),'D:\\Work\\문서.docx');
  for(const p of ['Z:\\school work\\문서.docx','\\\\server\\share\\file.docx','//server/share/file.docx','\\\\?\\C:\\file.docx','\\\\?\\UNC\\server\\share\\file.docx','E:\\USB\\file.pdf'])assert.ok(assertLocalPath(p,'win32'),p);
  assert.equal(assertLocalPath('\\\\?\\UNC\\server\\share\\file.docx','win32'),'\\\\server\\share\\file.docx');
  for(const p of ['relative.docx','C:\\file.docx:secret','C:relative.docx','https://site/file.docx','C:\\a\0.docx','C:\\'+ 'a'.repeat(32760),'\\\\.\\PhysicalDrive0','\\\\?\\GLOBALROOT\\Device\\x','\\\\server\\IPC$\\pipe','\\\\server','C:\\NUL.pdf','C:\\COM1','\\\\server\\share\\file.pdf:stream','\\\\server:80\\share\\file.pdf'])assert.throws(()=>assertLocalPath(p,'win32'),undefined,p);
  for(const ext of ['hwp','hwpx']){assert.equal(routeFile('한글.'+ext).targetExtension,'docx');assert.ok(dialogFilters()[0].extensions.includes(ext));}
});
test('batch limits, deduplication and argument parsing do not accept switches or URLs',()=>{
  assert.deepEqual(validateBatch(['a','a','b']),['a','b']);
  for(const p of [null,[],Array(9).fill('x'),[{}]])assert.throws(()=>validateBatch(p));
  const cwd=path.resolve('fixture');
  assert.deepEqual(fileArguments(['app.exe','--studio-test','--bad=option','https://host/file.pdf','report.docx'],{cwd}),[path.join(cwd,'report.docx')]);
  assert.deepEqual(fileArguments(['electron.exe','studio','slides.pptx'],{defaultApp:true,cwd}),[path.join(cwd,'slides.pptx')]);
});
test('source validation reads regular local files and rejects missing, directory and oversized input',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-routing-'));
  try{
    const filename=path.join(dir,'sample.docx');await fs.writeFile(filename,'test fixture');
    const file=await validateFile(filename);assert.equal(file.editor,'wordcraft');assert.equal(file.size,12);assert.equal(file.name,'sample.docx');
    await assert.rejects(validateFile(dir),/regular file/);
    await assert.rejects(validateFile(path.join(dir,'missing.docx')),/unavailable/);
    const huge=path.join(dir,'huge.docx');const handle=await fs.open(huge,'w');await handle.truncate(128*1024*1024+1);await handle.close();
    await assert.rejects(validateFile(huge),/128 MB/);
    await fs.writeFile(path.join(dir,'legacy.doc'),'legacy');await assert.rejects(validateFile(path.join(dir,'legacy.doc')),/Save As/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
