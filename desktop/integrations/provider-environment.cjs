'use strict';
function cleanEnvironment(env=process.env){const allow=new Set(['home','tmpdir','user','shell','logname','systemroot','windir','comspec','path','pathext','temp','tmp','userprofile','appdata','localappdata','programfiles','programfiles(x86)','homedrive','homepath','lang','lc_all']);return Object.fromEntries(Object.entries(env).filter(([k])=>allow.has(k.toLowerCase())));}
module.exports={cleanEnvironment};
