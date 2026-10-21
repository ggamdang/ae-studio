'use strict';
// Public-client OAuth only. No API-key fallback, copied CLI tokens, or embedded browser login.
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const crypto=require('node:crypto');
const OPENAI='https://auth.openai.com',DRIVE_SCOPE='https://www.googleapis.com/auth/drive.file';
const random=()=>crypto.randomBytes(32).toString('base64url');
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
async function jsonResponse(response,max=1024*1024){
  if(!response.ok){await response.body?.cancel();throw Error(`The account service returned HTTP ${response.status}. No automatic paid fallback was attempted.`);}
  const chunks=[];let n=0;for await(const b of response.body){n+=b.length;if(n>max)throw Error('Account response was too large.');chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString());
}
function validateIdToken(token,{jwks,issuer,clientId,nonce,subject,now=Date.now()/1000}){
  if(typeof token!=='string'||token.length>32768)throw Error('Missing identity token.');
  const parts=token.split('.');if(parts.length!==3)throw Error('Invalid identity token.');
  const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
  if(!['RS256','ES256'].includes(header.alg)||typeof header.kid!=='string')throw Error('Unsupported identity signature.');
  const jwk=jwks.keys?.find(k=>k.kid===header.kid&&(!k.use||k.use==='sig')&&(!k.alg||k.alg===header.alg));if(!jwk)throw Error('Identity signing key is missing.');
  if((header.alg==='RS256'&&jwk.kty!=='RSA')||(header.alg==='ES256'&&(jwk.kty!=='EC'||jwk.crv!=='P-256')))throw Error('Invalid identity signing key.');
  const key=crypto.createPublicKey({key:jwk,format:'jwk'});
  if(!crypto.verify('sha256',Buffer.from(parts.slice(0,2).join('.')),{key,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')))throw Error('Identity signature failed.');
  const aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(claims.iss!==issuer||!aud.includes(clientId)||(aud.length>1&&claims.azp!==clientId)||!Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+60||!equal(claims.nonce,nonce)||typeof claims.sub!=='string'||!claims.sub||subject&&claims.sub!==subject)throw Error('Identity validation failed. Please sign in again.');
  return claims;
}
function googlePublicClient(config){const c=config?.installed;if(!c||typeof c.client_id!=='string'||!/^[-a-zA-Z0-9.]+\.apps\.googleusercontent\.com$/.test(c.client_id)||c.client_id.length>300||typeof c.client_secret!=='string'||!c.client_secret||c.client_secret.length>300)throw Error('Choose the Google OAuth Desktop app JSON for AE Studio.');return {client_id:c.client_id,client_secret:c.client_secret};}
function createAccounts({dataDir,safeStorage,openExternal,fetchImpl=fetch,onChange=()=>{},timeoutMs=1800000,googleConfig=null}){
  const folder=path.join(dataDir,'Accounts'),file=path.join(folder,'accounts.enc');let db={hostId:'urn:uuid:'+crypto.randomUUID(),accounts:[],google:null},pending=null,lastError='',refreshing=new Map();
  function save(){if(!safeStorage.isEncryptionAvailable())throw Error('Protected credential storage is unavailable. Sign-in has been disabled.');fs.mkdirSync(folder,{recursive:true});const tmp=file+'.'+crypto.randomUUID();try{fs.writeFileSync(tmp,safeStorage.encryptString(JSON.stringify(db)),{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
  if(fs.existsSync(file)){try{if(!safeStorage.isEncryptionAvailable())throw Error();db=JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));if(!Array.isArray(db.accounts)||typeof db.hostId!=='string')throw Error();}catch{throw Error('Saved connections could not be unlocked. Your credentials have not been overwritten.');}}
  // Desktop OAuth clients are public client registrations, not user credentials.
  // Existing custom registrations and connected accounts always take precedence.
  if(!db.google&&googleConfig)db.google=googlePublicClient(googleConfig);
  function state(){return {pending:pending?.provider||null,pendingExpiresAt:pending?.expiresAt||null,pendingLoginHint:pending?.loginHint||null,error:lastError,googleConfigured:!!db.google,accounts:db.accounts.map(a=>({id:a.id,provider:a.provider,label:a.email||a.label||a.provider,connected:!!a.access_token,planEnabled:a.scopes?.includes('chatgpt.tokens.use.direct')||false}))};}
  function configureGoogle(config){if(pending)throw Error('Finish or cancel sign-in first.');const c=googlePublicClient(config);if(db.google&&db.google.client_id!==c.client_id&&db.accounts.some(a=>a.provider==='google'&&a.access_token))throw Error('Disconnect Google before changing the app registration.');db.google=c;save();return state();}
  async function request(url,options={}){return jsonResponse(await fetchImpl(url,{...options,redirect:'error',signal:options.signal||AbortSignal.timeout(20000)}));}
  async function post(url,body){return request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});}
  function cancel(){pending?.abort();return state();}
  async function connect(provider,id,email,pickFiles=false){
    if(!['chatgpt','google'].includes(provider))throw Error('Unknown account provider.');if(pending)throw Error('Finish or cancel the current sign-in.');if(provider==='google'&&!db.google)throw Error('Google app registration is required. Import the AE Studio Desktop OAuth configuration first.');
    const existing=id?db.accounts.find(a=>a.id===id&&a.provider===provider):null;if(id&&!existing)throw Error('Choose a saved account.');
    if(pickFiles&&(provider!=='google'||!existing))throw Error('Connect a Google account before choosing Drive files.');
    let loginHint='';
    if(provider==='google'){
      const requested=existing?.email||email||'';
      if(typeof requested!=='string'||requested.length>254)throw Error('Enter a valid Google account email, or leave it blank.');
      loginHint=requested.trim().toLowerCase();
      if(loginHint&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginHint))throw Error('Enter a valid Google account email, or leave it blank.');
    }
    save();const stateValue=random(),nonce=random(),verifier=random();let server,timer,settled=false;
    const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);server?.close();if(pending?.state===stateValue)pending=null;onChange(state());};
    const auth={provider,state:stateValue,loginHint,abort:()=>{lastError='Sign-in cancelled.';finish();}};pending=auth;lastError='';
    try{
      server=http.createServer(async(req,res)=>{
        const expectedHost='127.0.0.1:'+server.address()?.port;
        if(req.method!=='GET'||req.headers.host!==expectedHost||!req.url?.startsWith('/auth/callback?')){res.writeHead(404).end();return;}
        if(req.url.length>16384){res.writeHead(400).end();return;}
        const params=new URL(req.url,'http://'+expectedHost).searchParams;
        if(!equal(params.get('state'),stateValue)){res.writeHead(400).end('Invalid sign-in state.');return;}
        if(auth.used){res.writeHead(409).end();return;}auth.used=true;
        res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
        try{
          if(params.has('error'))throw Error('Sign-in was declined or cancelled.');const code=params.get('code');if(!code||code.length>8192)throw Error('Missing authorization code.');
          const client=provider==='google'?db.google.client_id:existing?.client_id||params.get('client_id');
          if(!client||client==='dynamic_agent_client'||client.length>300||(provider==='chatgpt'&&params.has('client_id')&&params.get('client_id')!==client))throw Error('The account registration did not match.');
          const form={grant_type:'authorization_code',client_id:client,code,code_verifier:verifier,redirect_uri:auth.redirect};
          if(provider==='chatgpt')form.resource='https://api.openai.com/v1';else form.client_secret=db.google.client_secret;
          const tokens=await post(provider==='chatgpt'?OPENAI+'/api/accounts/oauth/token':'https://oauth2.googleapis.com/token',form);
          if(settled)throw Error('Sign-in was cancelled.');
          if(typeof tokens.access_token!=='string'||tokens.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0)throw Error('Incomplete account authorization.');
          let claims={},scopes=String(tokens.scope||'').split(' ').filter(Boolean);
          if(provider==='chatgpt'){
            const discovery=await request(OPENAI+'/.well-known/openid-configuration');const url=new URL(discovery.jwks_uri);
            if(url.origin!==OPENAI||discovery.issuer!==OPENAI)throw Error('Unexpected identity configuration.');
            claims=validateIdToken(tokens.id_token,{jwks:await request(url.href),issuer:OPENAI,clientId:client,nonce,subject:existing?.subject});
          }else{
            if(!scopes.includes(DRIVE_SCOPE))throw Error('Google Drive file access was not granted.');
            const identity=await request('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId)',{headers:{Authorization:'Bearer '+tokens.access_token}});
            if(!identity.user?.permissionId||existing?.subject&&existing.subject!==identity.user.permissionId)throw Error('The selected Google account does not match. Add it as a new account.');
            claims={sub:identity.user.permissionId,email:identity.user.emailAddress};
          }
          const account={id:existing?.id||crypto.randomUUID(),provider,client_id:client,subject:claims.sub,email:claims.email,label:provider==='google'?'Google Drive '+(db.accounts.filter(a=>a.provider==='google').length+1):'ChatGPT',access_token:tokens.access_token,refresh_token:tokens.refresh_token||existing?.refresh_token,id_token:tokens.id_token,scopes,expires_at:Date.now()+tokens.expires_in*1000,pickedIds:provider==='google'?String(params.get('picked_file_ids')||'').split(',').filter(v=>/^[A-Za-z0-9_-]{1,200}$/.test(v)):[]};
          if(settled)throw Error('Sign-in was cancelled.');db.accounts=db.accounts.filter(a=>a.id!==account.id);db.accounts.push(account);save();res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}).end('Connected. You can close this tab and return to AE Studio.');
        }catch{lastError='Sign-in did not complete. Check consent and the app registration, then try again.';res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'}).end(lastError);}finally{finish();}
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      if(settled){server.close();throw Error('Sign-in cancelled.');}
      auth.redirect='http://127.0.0.1:'+server.address().port+'/auth/callback';
      const url=new URL(provider==='chatgpt'?OPENAI+'/api/accounts/authorize':'https://accounts.google.com/o/oauth2/v2/auth');
      const fields={client_id:provider==='chatgpt'?(existing?.client_id||'dynamic_agent_client'):db.google.client_id,response_type:'code',redirect_uri:auth.redirect,state:stateValue,code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url')};
      if(provider==='chatgpt'){Object.assign(fields,{scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:'https://api.openai.com/v1',nonce,ext_agent_host_id:db.hostId});if(existing?.id_token)fields.id_token_hint=existing.id_token;if(!existing)fields.agent_name_hint='AE Studio';}
      else{Object.assign(fields,{scope:DRIVE_SCOPE,access_type:'offline',prompt:'consent select_account'});if(pickFiles)Object.assign(fields,{trigger_onepick:'true',allow_multiple:'true'});if(loginHint)fields.login_hint=loginHint;}
      for(const [k,v] of Object.entries(fields))url.searchParams.set(k,v);auth.expiresAt=Date.now()+timeoutMs;timer=setTimeout(()=>{lastError='This sign-in attempt expired. Close its old browser tab, then start a new sign-in from AE Studio. Keep AE Studio open until the browser confirms the connection.';finish();},timeoutMs);timer.unref?.();await openExternal(url.href);return state();
    }catch(e){finish();throw e;}
  }
  function account(id,provider){const a=db.accounts.find(a=>a.id===id&&(!provider||a.provider===provider));if(!a?.access_token)throw Error('Connect this account first.');return a;}
  async function access(id){
    const a=account(id);if(a.expires_at>Date.now()+60000)return a.access_token;
    if(refreshing.has(id))return refreshing.get(id);
    const job=(async()=>{if(!a.refresh_token)throw Error('Sign in again to renew this connection.');const form={grant_type:'refresh_token',client_id:a.client_id,refresh_token:a.refresh_token};if(a.provider==='chatgpt')form.resource='https://api.openai.com/v1';else form.client_secret=db.google.client_secret;
      const result=await post(a.provider==='chatgpt'?OPENAI+'/api/accounts/oauth/token':'https://oauth2.googleapis.com/token',form);
      if(!a.access_token||!db.accounts.includes(a))throw Error('Account disconnected.');if(typeof result.access_token!=='string'||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw Error('Renewal failed. Sign in again.');a.access_token=result.access_token;a.refresh_token=result.refresh_token||a.refresh_token;a.expires_at=Date.now()+result.expires_in*1000;if(result.scope)a.scopes=result.scope.split(' ');if(result.id_token)a.id_token=result.id_token;save();return a.access_token;
    })();refreshing.set(id,job);try{return await job;}finally{refreshing.delete(id);}
  }
  async function disconnect(id){if(pending)cancel();const a=account(id);const token=a.refresh_token||a.access_token;delete a.access_token;delete a.refresh_token;delete a.id_token;save();let revoked=false;try{let endpoint='https://oauth2.googleapis.com/revoke';if(a.provider==='chatgpt'){endpoint=(await request(OPENAI+'/.well-known/openid-configuration')).revocation_endpoint;if(new URL(endpoint).origin!==OPENAI)throw Error();}const body=new URLSearchParams({token,token_type_hint:'refresh_token',client_id:a.client_id});const r=await fetchImpl(endpoint,{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(10000)});revoked=r.ok;await r.body?.cancel();}catch{}lastError=revoked?'':'Disconnected locally. Remote revocation was not confirmed; remove AE Studio in your provider account settings.';return state();}
  return {state,connect,cancel,configureGoogle,disconnect,access,account,request,fetchImpl};
}
module.exports={createAccounts,validateIdToken,jsonResponse,DRIVE_SCOPE};
