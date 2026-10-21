'use strict';
const fs=require('node:fs');
const path=require('node:path');
function installContext({isPackaged,execPath,root,env=process.env}) {
  const base=path.dirname(execPath);
  if(process.platform==='darwin')return {installed:isPackaged,dataDir:env.UNIFIED_STUDIO_DATA||path.join(require('node:os').homedir(),'Library/Application Support/AE Studio'),defaultsUrl:'https://support.apple.com/guide/mac-help/choose-an-app-to-open-a-file-mh35597/mac'};
  let installed=false;
  if(isPackaged)try{installed=JSON.parse(fs.readFileSync(path.join(base,'installation.json'),'utf8')).mode==='installed';}catch{}
  const dataDir=env.UNIFIED_STUDIO_DATA || (installed
    ? path.join(env.LOCALAPPDATA||path.join(env.USERPROFILE,'AppData','Local'),'UnifiedStudio','UserData')
    : isPackaged?path.join(base,'StudioData'):path.resolve(root,'../studio-data'));
  return {installed,dataDir,defaultsUrl:installed?'ms-settings:defaultapps?registeredAppUser=Unified%20Studio':'ms-settings:defaultapps'};
}
module.exports={installContext};
