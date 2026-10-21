'use strict';
const defaults=Object.freeze({theme:'system',sidebarCollapsed:false,toolbarCollapsed:false});
function normalize(value={}){return {theme:['light','dark','system'].includes(value.theme)?value.theme:'system',sidebarCollapsed:value.sidebarCollapsed===true,toolbarCollapsed:value.toolbarCollapsed===true};}
function geometry(value,width,height,error=false){const p=normalize(value),left=p.sidebarCollapsed?68:232,top=(p.toolbarCollapsed?40:68)+(error?80:0);return {x:left,y:top,width:Math.max(10,width-left),height:Math.max(10,height-top-28)};}
module.exports={defaults,normalize,geometry};
