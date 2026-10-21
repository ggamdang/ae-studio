const fs=require('node:fs'),path=require('node:path');
const rows=require('../desktop/mac-native.cjs').formats();
const text='# AE Studio Mac file-format guide\n\nThese are registered routing options, not certification of every feature of every format. Test copies of important files first.\n\n| Format | Opens in | Handling | Limits / notes |\n|---|---|---|---|\n'+rows.map(r=>`| .${r.extension} | ${r.workspace} | ${r.open} | ${r.notes} |`).join('\n')+'\n\nNative editors use their own import and export engines. File-opening registration cannot add a missing codec or guarantee format fidelity. HWP/HWPX and some legacy Office formats create new converted files and preserve the original. AE PDF Tools has operation-specific resource limits; the native PDF viewer is a separate editor. Mounted network drives require macOS permissions and a live connection.\n';
fs.mkdirSync(path.join(__dirname,'build','AE Studio'),{recursive:true});fs.writeFileSync(path.join(__dirname,'build','AE Studio','File-format guide.md'),text);
fs.writeFileSync(path.join(__dirname,'build','format-guide.json'),JSON.stringify(rows,null,2));
console.log(`${rows.length} format routes documented.`);
