// Original geometric mannequin, MIT. All geometry is generated here; no third-party model assets.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const frontend=process.env.ARTCRAFT_FRONTEND||path.resolve(here,'../../artcraft-v03/upstream/artcraft-main/frontend');
const THREE=await import(pathToFileURL(path.join(frontend,'node_modules/three/build/three.module.js')).href);
const {GLTFExporter}=await import(pathToFileURL(path.join(frontend,'node_modules/three/examples/jsm/exporters/GLTFExporter.js')).href);
const {mergeGeometries}=await import(pathToFileURL(path.join(frontend,'node_modules/three/examples/jsm/utils/BufferGeometryUtils.js')).href);
globalThis.FileReader=class{readAsArrayBuffer(blob){blob.arrayBuffer().then(x=>{this.result=x;this.onloadend?.();});}readAsDataURL(blob){blob.arrayBuffer().then(x=>{this.result='data:'+blob.type+';base64,'+Buffer.from(x).toString('base64');this.onloadend?.();});}};
const bones=[],parts=[];const model=new THREE.Group();model.name='StudioMannequin';
function bone(name,parent,pos){const b=new THREE.Bone();b.name='mixamorig'+name;b.position.set(...pos);(parent||model).add(b);bones.push(b);return b;}
const hips=bone('Hips',null,[0,1,0]);const spine=bone('Spine',hips,[0,.2,0]);const chest=bone('Spine1',spine,[0,.23,0]);const neck=bone('Neck',chest,[0,.25,0]);const head=bone('Head',neck,[0,.12,0]);
const ls=bone('LeftShoulder',chest,[.17,.13,0]),la=bone('LeftArm',ls,[.17,0,0]),le=bone('LeftForeArm',la,[.3,0,0]),lh=bone('LeftHand',le,[.27,0,0]);
const rs=bone('RightShoulder',chest,[-.17,.13,0]),ra=bone('RightArm',rs,[-.17,0,0]),re=bone('RightForeArm',ra,[-.3,0,0]),rh=bone('RightHand',re,[-.27,0,0]);
const ll=bone('LeftUpLeg',hips,[.12,-.07,0]),lk=bone('LeftLeg',ll,[0,-.43,0]),lf=bone('LeftFoot',lk,[0,-.43,0]);
const rl=bone('RightUpLeg',hips,[-.12,-.07,0]),rk=bone('RightLeg',rl,[0,-.43,0]),rf=bone('RightFoot',rk,[0,-.43,0]);model.updateMatrixWorld(true);
function part(b,geo,offset,color){geo.translate(...offset);geo.applyMatrix4(b.matrixWorld);const count=geo.attributes.position.count;const indices=[],weights=[],colors=[];const c=new THREE.Color(color);for(let i=0;i<count;i++){indices.push(bones.indexOf(b),0,0,0);weights.push(1,0,0,0);colors.push(c.r,c.g,c.b);}geo.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));geo.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));parts.push(geo.toNonIndexed());}
part(hips,new THREE.SphereGeometry(.18,16,12),[0,0,0],0xd6b68a);part(spine,new THREE.CapsuleGeometry(.19,.16,5,12),[0,.07,0],0x6eadd2);part(chest,new THREE.SphereGeometry(.22,16,12),[0,.06,0],0x6eadd2);part(neck,new THREE.CapsuleGeometry(.065,.07,4,10),[0,.04,0],0xd6b68a);part(head,new THREE.SphereGeometry(.14,16,12),[0,.09,0],0xd6b68a);
for(const [b,len,dir] of [[la,.3,1],[le,.27,1],[ra,.3,-1],[re,.27,-1]]){const g=new THREE.CapsuleGeometry(.06,len-.12,4,10);g.rotateZ(Math.PI/2);part(b,g,[dir*len/2,0,0],0x6eadd2);part(b,new THREE.SphereGeometry(.075,12,8),[0,0,0],0xd6b68a);}
for(const b of [lh,rh])part(b,new THREE.SphereGeometry(.07,12,8),[0,0,0],0xd6b68a);
for(const b of [ll,lk,rl,rk]){part(b,new THREE.CapsuleGeometry(.075,.28,4,10),[0,-.21,0],0x6eadd2);part(b,new THREE.SphereGeometry(.085,12,8),[0,0,0],0xd6b68a);}
for(const b of [lf,rf])part(b,new THREE.BoxGeometry(.13,.09,.24),[0,-.02,.06],0xd6b68a);
const geo=mergeGeometries(parts);const mesh=new THREE.SkinnedMesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.75}));mesh.name='StudioMannequinBody';model.add(mesh);mesh.bind(new THREE.Skeleton(bones));model.updateMatrixWorld(true);
const out=await new GLTFExporter().parseAsync(model,{binary:true});fs.writeFileSync(process.argv[2]||path.join(here,'assets/mannequin.glb'),Buffer.from(out));console.log('Original mannequin GLB:',out.byteLength,'bytes,',bones.length,'bones');
