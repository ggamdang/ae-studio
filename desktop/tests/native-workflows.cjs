'use strict';
// Runs only from the explicitly requested native UI test, never from normal startup.
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
const {dialog}=require('electron');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(100);}throw Error('Timed out waiting for native workflow UI.');}
async function run({pdf,testDir,nativeTools,evidence}){
  const root=path.resolve(__dirname,'..'),python=path.join(root,'pdf/runtime/python.exe'),script=path.join(__dirname,'native-ui-fixtures.py');
  const fixtureDir=path.join(testDir,'synthetic-inputs'),outputs={};
  await execFile(python,['-I','-B',script,'create',fixtureDir],{windowsHide:true,timeout:30000});
  const js=expression=>pdf.executeJavaScript(expression);
  const originalPicker=dialog.showOpenDialog;
  async function capture(name){await wait(250);await fs.writeFile(path.join(testDir,name+'.png'),(await pdf.capturePage()).toPNG());}
  async function inspect(){await js('document.getElementById("inspect").click()');await until(()=>js('!busy && !document.getElementById("page-image").hidden && document.getElementById("page-image").complete && document.getElementById("page-image").naturalWidth>0'));}
  async function setInputs(paths){nativeTools.addPDFInputs(paths);await js('api.selection().then(renderFiles)');}
  async function runAction(action,prepare=''){
    const before=new Set(await fs.readdir(testDir));
    await js(prepare+';document.getElementById("run").click()');
    await until(()=>js('!busy && (document.getElementById("status").textContent.startsWith("Finished") || document.getElementById("status").classList.contains("error"))'),60000);
    const message=await js('document.getElementById("status").textContent');assert.match(message,/^Finished/,action+': '+message);
    const names=(await fs.readdir(testDir)).filter(name=>!before.has(name)&&name.startsWith('Unified-PDF-'+action+'-'));
    assert.equal(names.length,1,action+' output folder');
    const folder=path.join(testDir,names[0]),result=(await fs.readdir(folder)).find(name=>name.endsWith('.pdf'));
    assert.ok(result,action+' PDF output');outputs[action]=path.join(folder,result);
    evidence.checks.push({id:'pdf-'+action,passed:true,message});
  }
  async function draw(box){
    const points=await js(`(()=>{const c=document.getElementById('selection');const r=c.getBoundingClientRect();const b=${JSON.stringify(box)};const center=(b.y0+b.y1)/2/preview.height*r.height;window.scrollTo(0,window.scrollY+r.top+center-window.innerHeight/2);const after=c.getBoundingClientRect();return {start:{x:Math.round(after.left+b.x0/preview.width*after.width),y:Math.round(after.top+b.y0/preview.height*after.height)},end:{x:Math.round(after.left+b.x1/preview.width*after.width),y:Math.round(after.top+b.y1/preview.height*after.height)}};})()`);
    await wait(150);
    pdf.sendInputEvent({type:'mouseMove',...points.start});pdf.sendInputEvent({type:'mouseDown',...points.start,button:'left',clickCount:1});
    pdf.sendInputEvent({type:'mouseMove',...points.end,button:'left'});pdf.sendInputEvent({type:'mouseUp',...points.end,button:'left',clickCount:1});
    await until(()=>js('boxes.length>0'));
    const actual=await js('boxes.at(-1)');for(const key of ['x0','y0','x1','y1'])assert.ok(Math.abs(actual[key]-box[key])<1,`${key}: ${actual[key]} vs ${box[key]}`);
  }
  // Mock only the test process's native picker. All selected paths are fresh synthetic files.
  async function pick(role,paths){
    let seen;
    dialog.showOpenDialog=async(_win,options)=>{seen=options;return {canceled:false,filePaths:paths};};
    try{await js(role==='signature'?'document.querySelector("#options button").click()':'document.getElementById("choose").click()');await until(()=>!!seen);await until(()=>js(role==='signature'?'signature?.name==="synthetic-signature.png"':`files[0]?.name===${JSON.stringify(path.basename(paths[0]))}`));return seen;}
    finally{dialog.showOpenDialog=originalPicker;}
  }
  try{
    await setInputs([path.join(fixtureDir,'form-and-marks.pdf')]);await inspect();await js('select("fill-form")');
    const form=await js('Array.from(document.querySelectorAll("[data-form-name]")).map(i=>({name:i.dataset.formName,type:i.type,value:i.value,checked:i.checked}))');
    assert.equal(form.find(f=>f.name==='consent').checked,false);assert.equal(form.find(f=>f.name==='student_name').value,'Before');assert.ok(!form.some(f=>f.name==='locked_note'));
    await capture('form-before');
    await runAction('fill-form','document.getElementById("option-form-student_name").value="Alice Example";document.getElementById("option-form-consent").checked=true');
    await js('select("add-text");document.getElementById("option-text").value="Added through the Studio UI"');
    await draw({x0:35,y0:340,x1:365,y1:375});await capture('add-text-placement');await runAction('add-text');
    await js('select("annotate");document.getElementById("option-text").value="Synthetic review note"');
    await draw({x0:280,y0:190,x1:350,y1:225});await runAction('annotate');
    await js('select("sign")');await pick('signature',[path.join(fixtureDir,'synthetic-signature.png')]);
    assert.equal(await js('!!preview'),true,'Signature selection keeps the document preview');
    await draw({x0:35,y0:390,x1:295,y1:465});await runAction('sign');
    await js('select("redact");document.getElementById("clear-boxes").click()');
    await draw({x0:30,y0:101,x1:250,y1:127});await capture('redaction-placement');
    await js('document.getElementById("run").click()');await until(()=>js('!busy && document.getElementById("status").classList.contains("error")'));
    assert.match(await js('document.getElementById("status").textContent'),/confirm/i);
    await runAction('redact','document.getElementById("option-confirmed").checked=true');
    await setInputs([path.join(fixtureDir,'form-and-marks.pdf'),path.join(fixtureDir,'different.pdf')]);await inspect();await js('select("redact")');await draw({x0:30,y0:101,x1:250,y1:127});
    await js('document.getElementById("password").value="synthetic-only";document.querySelectorAll("#files li button")[1].click()');await until(()=>js('files[0]?.name==="different.pdf"'));
    assert.deepEqual(await js('({preview:preview,boxCount:boxes.length,hidden:document.getElementById("page-image").hidden,label:document.getElementById("page-label").textContent,password:document.getElementById("password").value})'),{preview:null,boxCount:0,hidden:true,label:'No page',password:''});
    evidence.checks.push({id:'first-file-reorder-clears-preview-marks-password',passed:true});
    await inspect();assert.equal(await js('document.getElementById("page-label").textContent'),'1 / 1');
    await js('document.querySelectorAll("#files li button")[2].click()');await until(()=>js('files[0]?.name==="form-and-marks.pdf"'));assert.equal(await js('preview'),null);
    evidence.checks.push({id:'first-file-remove-clears-preview',passed:true});
    const pickerOptions=await pick('inputs',[path.join(fixtureDir,'static.html')]);assert.ok(pickerOptions.filters[0].extensions.includes('html'));assert.ok(pickerOptions.filters[0].extensions.includes('htm'));
    await runAction('html-to-pdf','select("html-to-pdf")');
    const selection=await js('api.selection()');assert.ok(!JSON.stringify(selection).includes(fixtureDir));
    evidence.checks.push({id:'native-picker-html-and-no-renderer-input-paths',passed:true});
    const manifest=path.join(testDir,'document-results.json');await fs.writeFile(manifest,JSON.stringify(outputs,null,2));
    const verification=await execFile(python,['-I','-B',script,'verify',manifest],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});evidence.documentVerification=JSON.parse(verification.stdout);
  }finally{dialog.showOpenDialog=originalPicker;}
}
module.exports={run};
