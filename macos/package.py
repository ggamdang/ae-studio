"""Package only after actual Mac tests pass. No paid signing or notarization."""
import hashlib,json,pathlib,plistlib,shutil,subprocess,tarfile
ROOT=pathlib.Path(__file__).resolve().parent;BUILD=ROOT/'build';SUITE=BUILD/'AE Studio';DIST=ROOT.parent/'dist';DIST.mkdir(exist_ok=True)
def run(args,**kw):return subprocess.run([str(a) for a in args],check=True,**kw)
for report in [ROOT/'checks/exports/result.json',ROOT/'checks/companion/result.json']:
    if not json.loads(report.read_text())['ok']:raise SystemExit('Release gate failed: '+str(report))
# Avoid bundle relocation: all apps stay together in one Applications folder.
components=BUILD/'components.plist'
run(['pkgbuild','--analyze','--root',SUITE,components])
rows=plistlib.loads(components.read_bytes())
for row in rows:
    row['BundleIsRelocatable']=False
    row['BundleIsVersionChecked']=True
    row['BundleOverwriteAction']='upgrade'
components.write_bytes(plistlib.dumps(rows))
package=DIST/'AE-Studio-0.9.1-Mac-Apple-Silicon-Preview.pkg'
run(['pkgbuild','--root',SUITE,'--component-plist',components,'--identifier','com.aeeducation.aestudio','--version','0.9.1','--install-location','/Applications/AE Studio',package])
# Test installation into the disposable CI Mac and compare every delivered file.
target=pathlib.Path('/Applications/AE Studio')
if target.exists():raise SystemExit('Refusing to touch an existing AE Studio installation.')
run(['sudo','installer','-pkg',package,'-target','/'])
checks=[]
for source in SUITE.rglob('*'):
    if not source.is_file() or source.is_symlink():continue
    relative=source.relative_to(SUITE);dest=target/relative
    if not dest.is_file():raise RuntimeError('Missing installed file: '+str(relative))
    with source.open('rb') as f:expected=hashlib.file_digest(f,'sha256').digest()
    with dest.open('rb') as f:actual=hashlib.file_digest(f,'sha256').digest()
    if expected!=actual:raise RuntimeError('Installed bytes differ: '+str(relative))
    checks.append(str(relative))
py=target/'AE Studio.app/Contents/Resources/app/pdf/runtime/python/bin/python3'
worker=target/'AE Studio.app/Contents/Resources/app/pdf/engine.py'
p=subprocess.run([str(py),'-I','-B',str(worker)],input=json.dumps({'action':'capabilities','options':{}}),text=True,capture_output=True,check=True)
capabilities=json.loads(p.stdout)
if not capabilities.get('ok'):raise RuntimeError('Installed worker did not start after relocation.')
report={'ok':True,'installedFilesVerified':len(checks),'workerRelocation':True,'architecture':'arm64','testedOS':'macOS 15 on GitHub-hosted Mac','publisherNotarized':False,'physicalMacAcceptance':False}
(DIST/'Installation-test.json').write_text(json.dumps(report,indent=2))
with package.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
(DIST/(package.name+'.sha256')).write_text(digest+'  '+package.name+'\n')
shutil.copytree(ROOT/'checks',DIST/'Verification',ignore=shutil.ignore_patterns('profile','control.token','control.json','control-key.*'),dirs_exist_ok=True)
print(json.dumps({'installer':package.name,'bytes':package.stat().st_size,'sha256':digest,'installation':report}),flush=True)
