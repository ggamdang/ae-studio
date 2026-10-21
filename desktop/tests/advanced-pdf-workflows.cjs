'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {dialog}=require('electron');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(150);}throw Error('Advanced PDF workflow timed out.');}

async function run({pdf,testDir,nativeTools,evidence}){
  const archive=process.env.STUDIO_TEST_ARCHIVE_FIXTURES;
  const language=process.env.STUDIO_TEST_LANGUAGE_FIXTURES;
  const js=code=>pdf.executeJavaScript(code);
  const picker=dialog.showOpenDialog;
  async function input(file){nativeTools.addPDFInputs([file]);await js('api.selection().then(renderFiles)');}
  async function pick(role,file){dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});try{await js(`api.pick(${JSON.stringify(role)}).then(renderFiles)`);}finally{dialog.showOpenDialog=picker;}}
  async function action(id,values={}){
    const before=new Set(await fs.readdir(testDir));
    await js(`select(${JSON.stringify(id)});(()=>{for(const [key,value] of Object.entries(${JSON.stringify(values)})){const input=document.getElementById('option-'+key);if(!input)throw Error('Missing option '+key);input.value=value;}})();document.getElementById('run').click();`);
    await until(()=>js('!busy'),10*60*1000);
    const status=await js('({text:document.getElementById("status").textContent,error:document.getElementById("status").classList.contains("error"),results:document.querySelectorAll(".result").length})');
    assert.equal(status.error,false,id+': '+status.text);assert.ok(status.results>0,id+' produces results');
    const folders=(await fs.readdir(testDir)).filter(name=>!before.has(name)&&name.startsWith('Unified-PDF-'+id+'-'));
    assert.equal(folders.length,1,id+' creates one fresh folder');
    const folder=path.join(testDir,folders[0]),files=await fs.readdir(folder);
    evidence.checks.push({id:'ui-'+id,passed:true,summary:status.text,files});
    await js('window.scrollTo(0,0)');await pause(150);
    await fs.writeFile(path.join(testDir,id+'.png'),(await pdf.capturePage()).toPNG());
    return {folder,files};
  }
  async function report(result,name){return JSON.parse(await fs.readFile(path.join(result.folder,name),'utf8'));}
  try{
    await until(()=>js('document.getElementById("capabilities").textContent.includes("Docling: local document models ready")'));
    assert.equal(await js('document.querySelectorAll("#operations button").length'),39);
    await input(path.join(archive,'source.pdf'));
    await pick('certificate',path.join(archive,'TEST_ONLY_SELF_SIGNED.p12'));
    const selection=await js('api.selection()');assert.ok(!JSON.stringify(selection).includes(archive));
    const signed=await action('certificate-sign',{certificatePassword:'Test-only-secret-93847!',reason:'Synthetic UI verification'});
    const signature=await report(signed,'signature-verification.json');assert.equal(signature.signatureCount,1);assert.equal(signature.signatures[0].integrityValid,true);
    assert.equal(await js('document.getElementById("option-certificatePassword").value'),'');
    await input(path.join(signed.folder,'certificate-signed.pdf'));await pick('trust',path.join(archive,'TEST_ONLY_SELF_SIGNED.pem'));
    const verified=await action('verify-signature');
    assert.equal((await report(verified,'signature-verification.json')).signatures[0].trustedBySuppliedRoots,true);
    await js('api.pick("clear-trust").then(renderFiles)');assert.equal(await js('trustCertificates.length'),0);
    await input(path.join(archive,'source.pdf'));
    const archival=await action('pdfa',{profile:'2b'});
    const archivePdf=archival.files.find(name=>name.endsWith('.pdf'));assert.ok(archivePdf);
    await input(path.join(archival.folder,archivePdf));const validation=await action('validate-pdfa',{profile:'auto'});
    const validationReport=validation.files.find(name=>name.endsWith('.json'));assert.equal((await report(validation,validationReport)).conforms,true);
    if(language){
      const fixtures=JSON.parse(await fs.readFile(path.join(language,'ui-fixtures.json'),'utf8'));
      await input(path.join(language,fixtures.english));const translation=await action('translate',{sourceLanguage:'en',targetLanguage:'ko'});
      const translationReport=await report(translation,'translation.json');assert.equal(translationReport.targetLanguage,'ko');assert.ok(translationReport.pages.some(page=>/[가-힣]/.test(page.translation)));
      await input(path.join(language,fixtures.koreanScan));const ocr=await action('ocr',{language:'eng+kor',dpi:250});assert.match(await fs.readFile(path.join(ocr.folder,'ocr.txt'),'utf8'),/[가-힣]/);
      await input(path.join(language,fixtures.table));const extracted=await action('ai-extract');assert.ok(extracted.files.some(name=>name.endsWith('.json'))&&extracted.files.some(name=>name.endsWith('.md')));
    }
    evidence.checks.push({id:'certificate-native-selection-password-clearing',passed:true});
  }finally{dialog.showOpenDialog=picker;}
}
module.exports={run};
