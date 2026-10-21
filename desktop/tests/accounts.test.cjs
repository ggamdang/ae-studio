'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createAccounts,validateIdToken,DRIVE_SCOPE}=require('../integrations/accounts.cjs');
const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('TEST-ENCRYPTED:'+Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(b.toString().slice(15),'base64').toString()};
const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...key.publicKey.export({format:'jwk'}),kid:'test',alg:'RS256'};
function signed(claims){const parts=[{alg:'RS256',kid:'test'},claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url'));return parts.join('.')+'.'+crypto.sign('sha256',Buffer.from(parts.join('.')),key.privateKey).toString('base64url');}
const claims=()=>({iss:'https://auth.openai.com',aud:'registered-client',sub:'subject-1',nonce:'nonce-1',exp:Date.now()/1000+600,iat:Date.now()/1000,email:'fixture@example.test'});

test('public desktop registration configures a fresh recipient without owner accounts and preserves custom registrations',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-public-client-'));const googleConfig={installed:{client_id:'public.apps.googleusercontent.com',client_secret:'public-desktop-secret'}};let login;
 try{const first=createAccounts({dataDir:dir,safeStorage:storage,googleConfig,openExternal:async u=>{login=new URL(u);}});assert.equal(first.state().googleConfigured,true);assert.deepEqual(first.state().accounts,[]);assert.doesNotMatch(JSON.stringify(first.state()),/public-desktop-secret/);
 await first.connect('google');assert.equal(login.searchParams.get('client_id'),googleConfig.installed.client_id);first.cancel();first.configureGoogle({installed:{client_id:'custom.apps.googleusercontent.com',client_secret:'custom-desktop-secret'}});
 const second=createAccounts({dataDir:dir,safeStorage:storage,googleConfig,openExternal:async u=>{login=new URL(u);}});await second.connect('google');assert.equal(login.searchParams.get('client_id'),'custom.apps.googleusercontent.com');second.cancel();assert.deepEqual(second.state().accounts,[]);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('OIDC identity checks reject wrong signature, nonce, audience, issuer, expiry and account substitution',()=>{
 const options={jwks:{keys:[jwk]},issuer:'https://auth.openai.com',clientId:'registered-client',nonce:'nonce-1'};assert.equal(validateIdToken(signed(claims()),options).sub,'subject-1');
 for(const change of [{iss:'https://attacker.test'},{aud:'wrong'},{nonce:'wrong'},{exp:0},{iat:Date.now()/1000+3600},{aud:['registered-client','other'],azp:'other'}])assert.throws(()=>validateIdToken(signed({...claims(),...change}),options));
 assert.throws(()=>validateIdToken(signed(claims()),{...options,subject:'another-account'}));const t=signed(claims()).split('.');t[1]=Buffer.from(JSON.stringify({...claims(),sub:'forged'})).toString('base64url');assert.throws(()=>validateIdToken(t.join('.'),options),/signature/);
});
test('ChatGPT public-client login checks state, uses PKCE, protects stored credentials and serializes token refresh',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-accounts-'));let login,refreshCount=0;
 const fakeFetch=async(url,options={})=>{const u=String(url);if(u.endsWith('openid-configuration'))return Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/jwks',revocation_endpoint:'https://auth.openai.com/revoke'});if(u.endsWith('/jwks'))return Response.json({keys:[jwk]});
 if(u.endsWith('/oauth/token')){assert.ok(options.body instanceof URLSearchParams);assert.equal(options.body.get('client_id'),'registered-client');if(options.body.get('grant_type')==='refresh_token'){refreshCount++;await new Promise(r=>setTimeout(r,15));return Response.json({access_token:'renewed-secret',refresh_token:'rotated-secret',expires_in:3600});}
 assert.equal(options.body.get('resource'),'https://api.openai.com/v1');assert.equal(crypto.createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'),login.searchParams.get('code_challenge'));return Response.json({access_token:'access-secret',refresh_token:'refresh-secret',token_type:'Bearer',expires_in:1,scope:'openid chatgpt.tokens.use.direct',id_token:signed({...claims(),nonce:login.searchParams.get('nonce')})});}
 if(u.endsWith('/revoke'))return new Response('',{status:200});throw Error('Unexpected URL '+u);};
 const accounts=createAccounts({dataDir:dir,safeStorage:storage,fetchImpl:fakeFetch,openExternal:async url=>{login=new URL(url);}});
 try{await accounts.connect('chatgpt');assert.equal(login.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(login.searchParams.get('agent_name_hint'),'AE Studio');
 const callback=new URL(login.searchParams.get('redirect_uri'));callback.searchParams.set('state','wrong');assert.equal((await fetch(callback)).status,400);assert.equal(accounts.state().accounts.length,0);
 callback.searchParams.set('state','한'.repeat(43));assert.equal((await fetch(callback)).status,400);
 callback.searchParams.set('state',login.searchParams.get('state'));callback.searchParams.set('code','fixture-code');callback.searchParams.set('client_id','registered-client');assert.equal((await fetch(callback)).status,200);
 const account=accounts.state().accounts[0];assert.equal(account.planEnabled,true);assert.equal(account.label,'fixture@example.test');assert.doesNotMatch(JSON.stringify(accounts.state()),/access-secret|refresh-secret|id_token/);
 const saved=await fs.readFile(path.join(dir,'Accounts/accounts.enc'),'utf8');assert.doesNotMatch(saved,/access-secret|refresh-secret/);
 assert.deepEqual(await Promise.all([accounts.access(account.id),accounts.access(account.id)]),['renewed-secret','renewed-secret']);assert.equal(refreshCount,1);
 await accounts.connect('chatgpt',account.id);await accounts.disconnect(account.id);assert.equal(accounts.state().pending,null);assert.equal(accounts.state().accounts[0].connected,false);await assert.rejects(accounts.access(account.id),/Connect/);
 }finally{accounts.cancel();assert.ok(path.basename(dir).startsWith('ae-accounts-'));await fs.rm(dir,{recursive:true,force:true});}
});
test('Google picker only requests selected-file access and rejects switching an existing account identity',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-google-'));let login,subject='google-1';
 const accounts=createAccounts({dataDir:dir,safeStorage:storage,openExternal:async u=>{login=new URL(u);},fetchImpl:async url=>String(url).includes('/about?')?Response.json({user:{permissionId:subject,emailAddress:'drive@example.test'}}):Response.json({access_token:'drive-secret',refresh_token:'drive-refresh',token_type:'Bearer',expires_in:3600,scope:DRIVE_SCOPE})});
 const callback=async(picked='')=>{const u=new URL(login.searchParams.get('redirect_uri'));for(const [k,v] of Object.entries({state:login.searchParams.get('state'),code:'code',picked_file_ids:picked}))u.searchParams.set(k,v);return fetch(u);};
 try{
  await assert.rejects(accounts.connect('google'),/registration/);accounts.configureGoogle({installed:{client_id:'fixture.apps.googleusercontent.com',client_secret:'desktop-secret'}});
  await assert.rejects(accounts.connect('google',undefined,undefined,true),/Connect a Google account/);
  await accounts.connect('google');assert.equal(login.searchParams.get('scope'),DRIVE_SCOPE);assert.equal(login.searchParams.get('prompt'),'consent select_account');assert.equal(login.searchParams.has('trigger_onepick'),false);assert.equal(login.searchParams.has('allow_multiple'),false);
  assert.equal((await callback()).status,200);const id=accounts.state().accounts[0].id;assert.deepEqual(accounts.account(id).pickedIds,[]);
  await accounts.connect('google',id,undefined,true);assert.equal(login.searchParams.get('trigger_onepick'),'true');assert.equal(login.searchParams.get('allow_multiple'),'true');assert.equal(login.searchParams.get('login_hint'),'drive@example.test');assert.equal(login.searchParams.get('scope'),DRIVE_SCOPE);
  assert.equal((await callback('file_1,file_2')).status,200);assert.deepEqual(accounts.account(id).pickedIds,['file_1','file_2']);assert.equal(accounts.state().accounts.length,1);
  subject='google-2';await accounts.connect('google',id,'different@example.test',true);assert.equal(login.searchParams.get('login_hint'),'drive@example.test');assert.equal((await callback()).status,400);assert.equal(accounts.account(id).subject,'google-1');assert.deepEqual(accounts.account(id).pickedIds,['file_1','file_2']);assert.doesNotMatch(JSON.stringify(accounts.state()),/desktop-secret|drive-secret/);
 }finally{accounts.cancel();await fs.rm(dir,{recursive:true,force:true});}
});
test('Google email hint guides a fresh login without persisting an owner account or changing permissions',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-google-hint-'));let login,opens=0;
 const accounts=createAccounts({dataDir:dir,safeStorage:storage,openExternal:async u=>{login=new URL(u);opens++;},fetchImpl:async()=>{throw Error('No provider requests expected');}});
 try{
  accounts.configureGoogle({installed:{client_id:'fixture.apps.googleusercontent.com',client_secret:'desktop-secret'}});
  for(const bad of ['not-an-email','a@example.test\nother@example.test','a'.repeat(255),{}])await assert.rejects(accounts.connect('google',undefined,bad),/valid Google account email/);
  assert.equal(opens,0);assert.equal(accounts.state().pending,null);
  await accounts.connect('google',undefined,'  Drive@Example.test  ');
  const remaining=accounts.state().pendingExpiresAt-Date.now();assert.ok(remaining>29*60*1000&&remaining<=30*60*1000);
  assert.equal(login.searchParams.get('login_hint'),'drive@example.test');assert.equal(login.searchParams.get('scope'),DRIVE_SCOPE);assert.equal(login.searchParams.get('prompt'),'consent select_account');
  assert.equal(accounts.state().pendingLoginHint,'drive@example.test');assert.equal(accounts.state().accounts.length,0);
  const persisted=JSON.parse(storage.decryptString(await fs.readFile(path.join(dir,'Accounts/accounts.enc'))));assert.doesNotMatch(JSON.stringify(persisted),/drive@example\.test/);
  accounts.cancel();assert.equal(accounts.state().pendingLoginHint,null);
  await accounts.connect('google');assert.equal(login.searchParams.has('login_hint'),false);
 }finally{accounts.cancel();await fs.rm(dir,{recursive:true,force:true});}
});

test('cancellation closes login and unavailable protected storage fails before opening a browser',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-cancel-'));let opened=false;
 const accounts=createAccounts({dataDir:dir,safeStorage:{isEncryptionAvailable:()=>false},openExternal:async()=>{opened=true;}});
 await assert.rejects(accounts.connect('chatgpt'),/storage/);assert.equal(opened,false);
 const okay=createAccounts({dataDir:dir,safeStorage:storage,openExternal:async()=>{}});await okay.connect('chatgpt');okay.cancel();assert.equal(okay.state().pending,null);await fs.rm(dir,{recursive:true,force:true});
});

test('expired sign-in closes its listener and retry uses fresh proof without exposing it in status',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ae-expiry-'));let login,requests=0;
 const accounts=createAccounts({dataDir:dir,safeStorage:storage,timeoutMs:40,fetchImpl:async()=>{requests++;throw Error('Unexpected token exchange');},openExternal:async u=>{login=new URL(u);}});
 try{
  await accounts.connect('chatgpt');const first=login,deadline=accounts.state().pendingExpiresAt;
  assert.ok(deadline>Date.now());assert.doesNotMatch(JSON.stringify(accounts.state()),/nonce|code_challenge|redirect_uri/);
  await new Promise(r=>setTimeout(r,80));assert.equal(accounts.state().pending,null);assert.equal(accounts.state().pendingExpiresAt,null);assert.match(accounts.state().error,/expired.*old browser tab/);
  await assert.rejects(fetch(first.searchParams.get('redirect_uri')+'?state='+first.searchParams.get('state')));
  await accounts.connect('chatgpt');assert.equal(accounts.state().error,'');assert.notEqual(login.searchParams.get('state'),first.searchParams.get('state'));assert.notEqual(login.searchParams.get('nonce'),first.searchParams.get('nonce'));assert.notEqual(login.searchParams.get('code_challenge'),first.searchParams.get('code_challenge'));assert.equal(requests,0);
 }finally{accounts.cancel();await fs.rm(dir,{recursive:true,force:true});}
});
