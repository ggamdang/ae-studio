const path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const [d,dataDir]=process.argv.slice(2);const {createAntigravity}=require(path.join(d,'integrations/antigravity.cjs'));
 const helper=createAntigravity({dataDir});await helper.install();const result=await helper.probe();assert(result.googleLogin);
 // Protocol initialization only: no account login, session, prompt, or billing.
 console.log(JSON.stringify({ok:true,...result}));
})().catch(e=>{console.error(e);process.exitCode=1;});
