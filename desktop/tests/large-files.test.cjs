'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {validateFile,groups,legacy}=require('../file-routing.cjs'),{rows}=require('../format-catalog.cjs'),{cleanEnvironment}=require('../integrations/plan-helpers.cjs');
test('large-file paths distinguish streaming video, decoded audio, documents and native PDF operations',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-large-'));const make=async(ext,size)=>{const p=path.join(dir,'file.'+ext),h=await fs.open(p,'w');await h.truncate(size);await h.close();return p;};
 try{const video=await make('mp4',2*1024**3),audio=await make('wav',2*1024**3),pdf=await make('pdf',1024**3),document=await make('docx',200*1024**2);
 const options={allowLarge:true,memoryBytes:8*1024**3};assert.equal((await validateFile(video,options)).streaming,true);await assert.rejects(validateFile(audio,options),/opening limit/);assert.equal((await validateFile(pdf,options)).editor,'pdf-tools');assert.equal((await validateFile(document,options)).large,true);await assert.rejects(validateFile(document),/128 MB/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('every advertised extension has one destination and an accurate format-list association',()=>{const exts=[...groups.flatMap(g=>g.extensions),...Object.keys(legacy)],matrix=rows();assert.equal(new Set(exts).size,exts.length);assert.equal(new Set(matrix.map(r=>r.extension)).size,matrix.length);for(const ext of exts)assert.equal(matrix.find(r=>r.extension===ext)?.association,true,ext);assert.equal(matrix.find(r=>r.extension==='indd').association,false);assert.equal(matrix.find(r=>r.extension==='avif').open,'Convert to PNG');});
test('official helpers do not inherit API credentials or runtime overrides',()=>{assert.deepEqual(cleanEnvironment({PATH:'fixture',OPENAI_API_KEY:'secret',ANTHROPIC_API_KEY:'secret',GEMINI_API_KEY:'secret',NODE_OPTIONS:'--require hostile.cjs',GOOGLE_GENAI_USE_VERTEXAI:'true',CLAUDE_CODE_USE_BEDROCK:'1',GEMINI_HOME:'somewhere',ANTIGRAVITY_HARNESS_PATH:'hostile.exe'}),{PATH:'fixture'});});
