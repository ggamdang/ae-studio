'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const {createAntigravity,RELEASE}=require('../integrations/antigravity.cjs');
test('Google setup rejects an altered download before unpacking or running it',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-google-download-'));let spawned=false;
 const helper=createAntigravity({dataDir:dir,spawnImpl:()=>{spawned=true;},fetchImpl:async(url,options)=>{assert.equal(url,RELEASE.url);assert.equal(options.redirect,'error');return new Response('tampered archive');}});
 try{await assert.rejects(helper.install(),/did not match/);assert.equal(helper.state().installed,false);assert.equal(helper.state().busy,false);assert.equal(spawned,false);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Google ACP uses isolated personal sign-in, rejects tools, and never requests generation during connection',{skip:!process.env.AE_TEST_GOOGLE_RUNTIME},async()=>{
 const dir=await fs.mkdtemp(path.join(path.dirname(process.env.AE_TEST_GOOGLE_RUNTIME),'rpc-test-')),runtime=path.join(dir,'ProviderHelpers/Antigravity',RELEASE.version);await fs.mkdir(runtime,{recursive:true});
 for(const name of Object.keys(RELEASE.files))await fs.link(path.join(process.env.AE_TEST_GOOGLE_RUNTIME,name),path.join(runtime,name));
 const messages=[];let proc,options,hold=false;
 const spawnImpl=(exe,args,opts)=>{options=opts;assert.equal(path.basename(exe),'agy_acp_server.exe');assert.deepEqual(args,[]);proc=new EventEmitter();proc.exitCode=null;proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.kill=()=>{proc.exitCode=0;proc.emit('close',0);};
 const reply=m=>queueMicrotask(()=>proc.stdout.write(JSON.stringify(m)+'\n'));
 proc.stdin=new Writable({write(data,encoding,done){for(const line of data.toString().trim().split('\n')){const m=JSON.parse(line);messages.push(m);if(!m.method)continue;if(hold)continue;
 let result={};if(m.method==='initialize')result={authMethods:[{id:'oauth-personal'}],agentInfo:{name:'fixture'}};
 if(m.method==='session/new'){result={sessionId:'fixture-session',models:{availableModels:[{modelId:'fixture',name:'Fixture'}]}};reply({jsonrpc:'2.0',id:900,method:'session/request_permission',params:{}});reply({jsonrpc:'2.0',id:901,method:'fs/read_text_file',params:{path:'private'}});}
 reply({jsonrpc:'2.0',id:m.id,result});}done();}});return proc;};
 const helper=createAntigravity({dataDir:dir,spawnImpl});
 try{const connected=await helper.connect();assert.equal(connected.models[0].id,'fixture');assert.equal(helper.state().connected,true);assert.equal(helper.state().busy,false);
 assert.deepEqual(messages.find(m=>m.method==='initialize').params.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false});
 assert.deepEqual(messages.find(m=>m.method==='authenticate').params,{methodId:'oauth-personal'});
 const session=messages.find(m=>m.method==='session/new').params;assert.deepEqual(session.mcpServers,[]);assert.deepEqual(session._meta.antigravity.enabledTools,[]);assert.ok(session.cwd.startsWith(dir));
 assert.deepEqual(messages.find(m=>m.id===900).result,{outcome:{outcome:'cancelled'}});assert.equal(messages.find(m=>m.id===901).error.code,-32601);assert.equal(messages.some(m=>m.method==='session/prompt'),false);
 assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.ok(options.env.GEMINI_HOME.startsWith(dir));assert.ok(options.env.ANTIGRAVITY_HARNESS_PATH.startsWith(runtime));assert.equal(options.env.GEMINI_API_KEY,undefined);
 hold=true;const pending=helper.probe();for(let i=0;i<100&&!helper.state().busy;i++)await new Promise(r=>setTimeout(r,50));assert.equal(helper.state().busy,true);helper.cancel();await assert.rejects(pending,/cancelled/);assert.equal(helper.state().busy,false);
 await helper.disconnect();assert.equal(helper.state().connected,false);
 }finally{helper.cancel();await fs.rm(dir,{recursive:true,force:true});}
});
