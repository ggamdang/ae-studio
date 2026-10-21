"""Embed an approved public desktop OAuth registration, never account tokens."""
import json,os,pathlib,re

ROOT=pathlib.Path(__file__).resolve().parent

def public_client(raw):
    if len(raw)>16384:raise ValueError('Desktop registration is too large')
    data=json.loads(raw)
    if not isinstance(data,dict) or set(data)!={'installed'}:raise ValueError('A desktop registration is required')
    client=data['installed']
    allowed={'client_id','client_secret','project_id','auth_uri','token_uri','auth_provider_x509_cert_url','redirect_uris'}
    if not isinstance(client,dict) or set(client)-allowed:raise ValueError('Unexpected registration fields; account credentials are not accepted')
    ident=client.get('client_id');secret=client.get('client_secret')
    if not isinstance(ident,str) or len(ident)>300 or not re.fullmatch(r'[-a-zA-Z0-9.]+\.apps\.googleusercontent\.com',ident):raise ValueError('Invalid desktop client identifier')
    if not isinstance(secret,str) or not 0<len(secret)<=300:raise ValueError('Invalid desktop client configuration')
    return {'installed':{'client_id':ident,'client_secret':secret}}

def main():
    raw=os.environ.pop('AE_GOOGLE_DESKTOP_JSON','')
    if os.environ.get('AE_REQUIRE_GOOGLE_REGISTRATION')=='1' and not raw:raise RuntimeError('The approved Google desktop registration is missing from encrypted build settings')
    suite=ROOT/'build/AE Studio';app=suite/'AE Studio.app/Contents/Resources/app'
    if not app.is_dir():raise RuntimeError('Build the app before adding its registration')
    config=public_client(raw) if raw else None
    if config:
        target=app/'integrations/google-desktop.json'
        with target.open('x',encoding='utf-8') as output:json.dump(config,output)
        target.chmod(0o644)  # A desktop OAuth registration is shipped to recipients.
    if any((suite/'Source').rglob('google-desktop.json')):raise RuntimeError('Registration must be excluded from the source folder')
    report={'included':config is not None,'personalAccountTokensIncluded':False,'sourceContainsRegistration':False,'personalSignInTested':False}
    (ROOT/'build/google-registration.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)

if __name__=='__main__':main()
