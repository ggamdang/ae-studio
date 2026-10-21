'use strict';
const path=require('node:path');
const ROOT=__dirname;
const mac=process.platform==='darwin';
module.exports={
  python:path.join(ROOT,'pdf/runtime',mac?'python/bin/python3':'python.exe'),
  office:path.join(ROOT,'pdf/runtime/libreoffice',mac?'LibreOffice.app/Contents/MacOS/soffice':'program/soffice.com'),
  hangul:path.join(ROOT,'hangul-runtime',mac?'hwp':'hwp.exe'),
  localAI:process.env.AE_LOCAL_AI_ROOT||(mac?path.join(require('node:os').homedir(),'Library/Application Support/AE Studio/Local AI'):path.join(ROOT,'local-ai')),
};
