const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const [d,fixtures,out]=process.argv.slice(2);const input=path.join(fixtures,'korean-table.hwp');const before=await fs.readFile(input);
 const docx=await require(path.join(d,'integrations/hangul-convert.cjs')).convertHangul(input,out);
 const {unzipSync,strFromU8}=require(path.join(d,'node_modules/fflate'));
 const xml=strFromU8(unzipSync(await fs.readFile(docx))['word/document.xml']);assert(xml.includes('한글 가져오기 확인'));
 assert.deepEqual(await fs.readFile(input),before);
 console.log(JSON.stringify({ok:true,conversion:'Korean HWP to editable DOCX',originalPreserved:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
