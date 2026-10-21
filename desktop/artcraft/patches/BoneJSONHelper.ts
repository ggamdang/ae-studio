// Local pose persistence for imported rigs. The old ArtCraft pose format remains readable.
import {Object3D, ObjectLoader} from 'three';
export class BoneJSONHelper {
  constructor(public model:Object3D) {}
  private findHipBone(nodes:Object3D[]):Object3D|undefined {
    for(const node of nodes) {
      if(node.type==='Bone' && node.name.toLowerCase().includes('mixamorighips')) return node;
      const found=this.findHipBone(node.children); if(found) return found;
    }
    return undefined;
  }
  public toJSON():any {
    if(!this.model.userData.isCharacter) return undefined;
    const bones:any[]=[];
    const visit=(node:Object3D,path:number[])=>{
      if(node.type==='Bone') bones.push({path,name:node.name,position:node.position.toArray(),quaternion:node.quaternion.toArray(),scale:node.scale.toArray()});
      node.children.forEach((child,index)=>visit(child,[...path,index]));
    };
    visit(this.model,[]);
    return {format:'unified-bone-pose',version:1,bones};
  }
  private applyBoneTree(target:Object3D,source:Object3D):void {
    target.position.copy(source.position);target.quaternion.copy(source.quaternion);target.scale.copy(source.scale);
    target.children.forEach((child,index)=>{if(source.children[index])this.applyBoneTree(child,source.children[index]);});
  }
  public poseFromBoneJSON(pose:any):void {
    if(pose?.format==='unified-bone-pose') {
      if(pose.version!==1 || !Array.isArray(pose.bones) || pose.bones.length>10000)throw new Error('Invalid local bone pose');
      const vector=(v:any,n:number)=>Array.isArray(v)&&v.length===n&&v.every((x:any)=>typeof x==='number'&&Number.isFinite(x));
      for(const bone of pose.bones) {
        if(!Array.isArray(bone.path)||bone.path.length>100||!bone.path.every((x:any)=>Number.isInteger(x)&&x>=0)||!vector(bone.position,3)||!vector(bone.quaternion,4)||!vector(bone.scale,3))throw new Error('Invalid bone transform');
        let target:Object3D|undefined=this.model;
        for(const index of bone.path)target=target?.children[index];
        if(target?.type==='Bone'){target.position.fromArray(bone.position);target.quaternion.fromArray(bone.quaternion);target.scale.fromArray(bone.scale);}
      }
      return;
    }
    const hip=this.findHipBone(this.model.children);if(hip)this.applyBoneTree(hip,new ObjectLoader().parse(pose));
  }
}
