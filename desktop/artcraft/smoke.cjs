'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
exports.run=async function({contents,testDir}){
 const OUT=testDir;fs.mkdirSync(OUT,{recursive:true});const report={checks:[]};const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const js=source=>contents.executeJavaScript(source);const shot=async name=>fs.promises.writeFile(path.join(OUT,name),(await contents.capturePage()).toPNG());
 const until=async(source,timeout=30000)=>{for(let n=0;n<timeout/200;n++){if(await js(source))return;await wait(200);}throw new Error('Timeout: '+source);};
 await until('!!window.unifiedArtcraft');await wait(800);await shot('01-start.png');
 try{
 await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("New 1280")).click()');await until('document.querySelectorAll("canvas").length>1');
 await js(`(()=>{const s=unifiedArtcraft.getCanvasStore();s.createRectangle(100,90,250,160,'#4488cc');s.createCircle(520,210,80,'#ec9a49');s.addLineNode({id:'qa-stroke',type:'line',points:[150,320,280,390,500,340],stroke:'#db6b87',strokeWidth:16,draggable:true},true);s.addLineNode({id:'line-inpaint-qa-mask',type:'line',points:[600,280,680,320],stroke:'#ffffff',strokeWidth:60,draggable:false},true);})()`);
 await wait(700);await shot('02-canvas.png');
 await js(`(async()=>{const s=unifiedArtcraft.getCanvasStore();await s.undo();await s.redo();return true;})()`);
 report.checks.push({id:'canvas-shapes-drawing-mask',state:await js('({nodes:unifiedArtcraft.getCanvasStore().drawNodes.length,masks:unifiedArtcraft.getCanvasStore().inpaintLineNodes.length})')});
 const png=await js('unifiedArtcraft.exportPng().then(async b=>({size:b.size,type:b.type,data:Array.from(new Uint8Array(await b.arrayBuffer()))}))');fs.writeFileSync(path.join(OUT,'canvas-export.png'),Buffer.from(png.data));report.checks.push({id:'canvas-png-export',size:png.size,type:png.type});
 const fixture=fs.readFileSync(path.join(__dirname,'fixtures','original-figure.png')).toString('base64');
 const importFigure=`(async()=>{const blob=await(await fetch('data:image/png;base64,${fixture}')).blob();return await unifiedArtcraft.importFile(new File([blob],'Original figure.png',{type:'image/png'}));})()`;
 await js(importFigure);await until("unifiedArtcraft.getCanvasStore().drawNodes.some(n=>n.type==='image'&&n.imageElement)");
 const imageBefore=await js(`(()=>{const s=unifiedArtcraft.getCanvasStore();const n=s.drawNodes.find(n=>n.type==='image');s.updateNode(n.id,{x:170,y:120,rotation:12});s.selectNode(n.id);return {id:n.id,url:n.imageUrl};})()`);
 await js(`document.querySelector('[data-action="remove-background"]').click()`);
 await until(`unifiedArtcraft.getCanvasStore().drawNodes.find(n=>n.id===${JSON.stringify(imageBefore.id)})?.imageUrl!==${JSON.stringify(imageBefore.url)}&&!document.querySelector('[data-action="remove-background"]').disabled`,120000);
 const cutout=await js(`(()=>{const n=unifiedArtcraft.getCanvasStore().drawNodes.find(n=>n.type==='image');const c=document.createElement('canvas');c.width=n.imageElement.width;c.height=n.imageElement.height;const x=c.getContext('2d');x.drawImage(n.imageElement,0,0);const a=x.getImageData(0,0,c.width,c.height).data;let transparent=0,opaque=0;for(let i=3;i<a.length;i+=4){if(a[i]<10)transparent++;if(a[i]>245)opaque++;}return {x:n.x,y:n.y,rotation:n.rotation,transparent,opaque};})()`);
 assert.ok(cutout.transparent>1000&&cutout.opaque>1000);assert.equal(cutout.x,170);assert.equal(cutout.y,120);assert.equal(cutout.rotation,12);report.checks.push({id:'local-background-removal-ui',cutout});await shot('02b-local-cutout.png');
 await js(`(async()=>{const blob=await(await fetch('data:image/png;base64,${fixture}')).blob();unifiedArtcraft.getCanvasStore().createImage(520,400,new File([blob],'Native layer.png',{type:'image/png'}));})()`);await until('unifiedArtcraft.getCanvasStore().drawNodes.length===5');
 await js('unifiedArtcraft.setTab("3D")');await until('unifiedArtcraft.getSceneStore().is3DSceneLoaded');await wait(700);
 await js('unifiedArtcraft.addShape("Box")');await js('unifiedArtcraft.addShape("Sphere")');await js('unifiedArtcraft.addShape("PointLight")');const id=await js('unifiedArtcraft.addMannequin()');await js(`void unifiedArtcraft.select(${JSON.stringify(id)})`);await wait(1200);await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Enter Pose Mode')).click()`);await until(`unifiedArtcraft.getSceneStore().poseMode==='pose'`);await shot('03-scene.png');await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Done').click()`);
 report.checks.push({id:'scene-shapes-light-mannequin',state:await js('unifiedArtcraft.getSceneStore().outlinerItems.map(x=>({id:x.id,name:x.name,type:x.type}))')});
 await js(`(()=>{const e=unifiedArtcraft.getEditor();const o=e.activeScene.scene.getObjectByProperty('uuid',${JSON.stringify(id)});o.getObjectByName('mixamorigLeftArm').rotation.z=.6;o.getObjectByName('mixamorigRightForeArm').rotation.y=.8;o.position.x=.5;return true;})()`);await wait(400);await shot('04-posed-scene.png');
 await js(`unifiedArtcraft.getSceneStore().updateCamera('cam2',{focalLength:35})`);
 const imported=await js(`(async()=>{const blob=await(await fetch('/local-assets/mannequin.glb')).blob();return await unifiedArtcraft.importFile(new File([blob],'Imported rig.glb',{type:'model/gltf-binary'}));})()`);assert.equal(imported.ok,true);
 await js(importFigure);assert.equal(await js("!!unifiedArtcraft.getEditor().activeScene.scene.getObjectByName('Original figure.png')"),true);report.checks.push({id:'local-image-plane-import',passed:true});
 const project=await js('unifiedArtcraft.snapshot()');fs.writeFileSync(path.join(OUT,'roundtrip.artcraft'),JSON.stringify(project));
 await js('unifiedArtcraft.saveLocal()');await js('unifiedArtcraft.getEditor().newScene("Empty")');await js(`unifiedArtcraft.openProject(${JSON.stringify(project)})`);await wait(800);
 const restored=await js(`(()=>{const o=unifiedArtcraft.getEditor().activeScene.scene.getObjectByName('Studio mannequin');return {objects:unifiedArtcraft.getEditor().activeScene.scene.children.map(x=>x.name),bone:o?.getObjectByName('mixamorigLeftArm')?.rotation.z,x:o?.position.x,camera:unifiedArtcraft.getSceneStore().cameras.find(c=>c.id==='cam2').focalLength,imported:!!unifiedArtcraft.getEditor().activeScene.scene.getObjectByName('Imported rig.glb'),imagePlane:!!unifiedArtcraft.getEditor().activeScene.scene.getObjectByName('Original figure.png'),canvasNodes:unifiedArtcraft.getCanvasStore().drawNodes.length,imageLoaded:!!unifiedArtcraft.getCanvasStore().drawNodes.find(n=>n.type==='image')?.imageElement,nativeFileLayerLoaded:!!unifiedArtcraft.getCanvasStore().drawNodes.find(n=>n.type==='image'&&n.x===520&&n.imageUrl?.startsWith('data:'))?.imageElement};})()`);report.checks.push({id:'portable-scene-pose-canvas-roundtrip',restored});
 await js('unifiedArtcraft.captureToCanvas()');await until('unifiedArtcraft.getCanvasStore().drawNodes.length===6');await wait(600);await shot('05-scene-to-canvas.png');
 report.checks.push({id:'scene-capture-to-canvas',state:await js(`({layers:unifiedArtcraft.getCanvasStore().drawNodes.length,imageLayers:unifiedArtcraft.getCanvasStore().drawNodes.filter(n=>n.type==='image').length})`)});
 await js(importFigure);await until('unifiedArtcraft.getCanvasStore().drawNodes.length===7');report.checks.push({id:'image-import-after-return-to-canvas',passed:true});
 assert.equal(report.checks[0].state.nodes,3);assert.equal(report.checks[0].state.masks,1);assert.ok(png.size>1000);assert.ok(Math.abs(restored.bone-.6)<.00001,'Pose must survive project reopen');assert.equal(restored.x,.5);assert.equal(restored.camera,35);assert.equal(restored.imported,true);assert.equal(restored.imagePlane,true);assert.equal(project.media.length,4);assert.equal(restored.canvasNodes,5);assert.equal(restored.nativeFileLayerLoaded,true);assert.equal(restored.imageLoaded,true);report.passed=true;
 }catch(e){report.passed=false;report.error=e.stack;await shot('error.png');}

 fs.writeFileSync(path.join(OUT,'artcraft-results.json'),JSON.stringify(report,null,2));return report;
};
