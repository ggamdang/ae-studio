"""Build a relocatable Apple-silicon AE Studio bundle using free runtimes."""
import concurrent.futures,hashlib,json,os,pathlib,plistlib,shutil,subprocess,sys,tarfile,tempfile,urllib.request,zipfile
from xml.sax.saxutils import escape
ROOT=pathlib.Path(__file__).resolve().parent
REPO=ROOT.parent;SOURCE=REPO/'desktop';BUILD=ROOT/'build';SUITE=BUILD/'AE Studio'
LOCK=json.loads((ROOT/'runtime-lock.json').read_text())
RECORDS=[]
def run(args,**kw):return subprocess.run([str(x) for x in args],check=True,**kw)
def fetch(pin,destination=None):
    name=pin['url'].rsplit('/',1)[1];dest=destination or BUILD/'downloads'/name
    dest.parent.mkdir(parents=True,exist_ok=True)
    if not dest.exists():
        request=urllib.request.Request(pin['url'],headers={'User-Agent':'AE-Studio-Mac-build'})
        with urllib.request.urlopen(request,timeout=180) as src,dest.open('wb') as out:shutil.copyfileobj(src,out)
    with dest.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
    if actual!=pin['sha256']:raise RuntimeError('Checksum mismatch: '+name)
    RECORDS.append({'url':pin['url'],'sha256':actual,'bytes':dest.stat().st_size})
    return dest
def extract(archive,target):
    target.mkdir(parents=True,exist_ok=True)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            for n in z.namelist():
                if not (target/n).resolve().is_relative_to(target.resolve()):raise RuntimeError('Unsafe ZIP path')
            z.extractall(target)
    else:
        with tarfile.open(archive) as t:t.extractall(target,filter='data')
def copy_dmg(archive,target):
    mount=pathlib.Path(tempfile.mkdtemp(prefix='ae-office-'))
    try:
        run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',mount,archive],stdout=subprocess.DEVNULL)
        app=next(mount.glob('*.app'));target.mkdir(parents=True,exist_ok=True)
        run(['ditto',app,target/app.name])
    finally:
        run(['hdiutil','detach',mount],stdout=subprocess.DEVNULL);mount.rmdir()
def make_python(archive,runtime,code_root):
    extract(archive,runtime)
    py=runtime/'python/bin/python3'
    run([py,'-m','pip','--version'])
    packages=next((runtime/'python/lib').glob('python*/site-packages'))
    # The workers run with -I. A bundled relative .pth enables only our source.
    (packages/'ae-studio.pth').write_text(os.path.relpath(code_root,packages)+'\n')
    link=runtime/'site-packages'
    if not link.exists():link.symlink_to(os.path.relpath(packages,runtime),target_is_directory=True)
    return py,packages
def collect_sources(py,target):
    target.mkdir(parents=True,exist_ok=True)
    code='import importlib.metadata,json;print(json.dumps([{\"name\":d.metadata[\"Name\"],\"version\":d.version} for d in importlib.metadata.distributions()]))'
    distributions=json.loads(subprocess.check_output([str(py),'-c',code]))
    records=[]
    for d in distributions:
        info=json.load(urllib.request.urlopen(f'https://pypi.org/pypi/{d["name"]}/{d["version"]}/json',timeout=60))
        sources=[x for x in info['urls'] if x['packagetype']=='sdist']
        d['license']=info['info'].get('license_expression') or info['info'].get('license')
        d['sourceURLs']=info['info'].get('project_urls')
        d['sources']=[]
        for item in sources:
            pin={'url':item['url'],'sha256':item['digests']['sha256']}
            fetch(pin,target/item['filename']);d['sources'].append(pin)
        records.append(d)
    (target/'packages.json').write_text(json.dumps(records,indent=2))

def main():
    if sys.platform!='darwin':raise SystemExit('Build on macOS.')
    run(['npm','ci','--no-audit','--no-fund'],cwd=SOURCE)
    electron_env={k:v for k,v in os.environ.items() if k!='ELECTRON_SKIP_BINARY_DOWNLOAD'}
    run(['node','node_modules/electron/install.js'],cwd=SOURCE,env=electron_env)
    app=SUITE/'AE Studio.app'
    if app.exists():raise RuntimeError('Build destination already exists; use a fresh CI checkout.')
    run(['ditto',SOURCE/'node_modules/electron/dist/Electron.app',app])
    d=app/'Contents/Resources/app'
    shutil.copytree(SOURCE,d,ignore=shutil.ignore_patterns('node_modules','__pycache__','*.pyc','tests','.gitignore'))
    shutil.copytree(SOURCE/'node_modules/fflate',d/'node_modules/fflate')
    runtime=d/'pdf/runtime';runtime.mkdir(parents=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        downloaded=dict(zip(LOCK,pool.map(fetch,LOCK.values())))
    py,packages=make_python(downloaded['python'],runtime,d/'pdf')
    run([py,'-m','pip','install','--no-cache-dir','-r',d/'pdf/requirements-lock.txt'])
    run([py,'-m','pip','install','--no-cache-dir','-r',d/'pdf/archive-requirements-lock.txt'])
    copy_dmg(downloaded['office'],runtime/'libreoffice')
    archive=runtime/'archive';archive.mkdir()
    (archive/'site-packages').symlink_to('../site-packages',target_is_directory=True)
    extract(downloaded['java'],archive/'java')
    extract(downloaded['verapdf'],BUILD/'vera-installer')
    jar=next((BUILD/'vera-installer').rglob('*.jar'))
    java=next((archive/'java').glob('*/Contents/Home/bin/java'))
    xml=BUILD/'vera-install.xml'
    xml.write_text('<AutomatedInstallation langpack="eng"><com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/><com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>'+escape(str(archive/'verapdf'))+'</installpath></com.izforge.izpack.panels.target.TargetPanel><com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select"><pack index="0" name="veraPDF GUI" selected="false"/><pack index="1" name="veraPDF CLI" selected="true"/><pack index="2" name="veraPDF Documentation" selected="true"/><pack index="3" name="veraPDF Sample Plugins" selected="false"/></com.izforge.izpack.panels.packs.PacksPanel><com.izforge.izpack.panels.install.InstallPanel id="install"/><com.izforge.izpack.panels.finish.FinishPanel id="finish"/></AutomatedInstallation>')
    run([java,'-jar',jar,xml],timeout=180)
    hangul=d/'hangul-runtime';extract(downloaded['hangul'],hangul)
    hwp=next(hangul.rglob('hwp'));hwp.chmod(0o755)
    if hwp!=hangul/'hwp':shutil.copy2(hwp,hangul/'hwp')
    (hangul/'manifest.json').write_text(json.dumps({'name':'hwp-cli','version':'1.3.1','license':'MIT OR Apache-2.0','source':'https://github.com/STAIxBWLB/hwp-cli/tree/v1.3.1','executableSha256':hashlib.sha256((hangul/'hwp').read_bytes()).hexdigest()}))
    bg=json.loads((d/'integrations/background/manifest.json').read_text());model=next(x for x in bg['files'] if x['path'].endswith('.onnx'))
    fetch({'url':bg['modelSource'],'sha256':model['sha256']},d/'integrations/background'/model['path'])
    language=runtime/'language'
    lpy,lpackages=make_python(downloaded['python'],language,d/'pdf')
    # Original capability discovery uses this platform-independent package link.
    (language/'python/site-packages').symlink_to(os.path.relpath(lpackages,language/'python'),target_is_directory=True)
    requirements=d/'pdf/language-requirements-lock.txt'
    requirements.write_text('\n'.join(x for x in requirements.read_text().splitlines() if not x.lower().startswith('pywin32=='))+'\n')
    run([lpy,'-m','pip','install','--no-cache-dir','-r',requirements])
    for pin in json.loads((d/'pdf/language-downloads.json').read_text()):fetch(pin,language/pin['path'])
    for repo in json.loads((d/'pdf/language-docling-models.json').read_text()):
        for pin in repo['files']:fetch(pin,language/'docling-models'/pin['path'])
    run([lpy,d/'pdf/language_m2m_setup.py'],timeout=900)
    # Actual bundle names come from mounted DMGs, not product-name assumptions.
    index=json.loads((BUILD/'native-index.json').read_text());apps=json.loads((d/'native-apps.json').read_text())
    for item in apps:item['bundleName']=index[item['id']]['bundleName']
    (d/'native-apps.json').write_text(json.dumps(apps,indent=2))
    info_path=app/'Contents/Info.plist';info=plistlib.loads(info_path.read_bytes())
    info.update(CFBundleDisplayName='AE Studio',CFBundleName='AE Studio',CFBundleIdentifier='com.aeeducation.aestudio',CFBundleShortVersionString='0.9.1',CFBundleVersion='0.9.1',LSMinimumSystemVersion='15.0')
    extensions=set(x for a in apps for x in a['extensions'])|{'hwp','hwpx','artcraft','glb','ppt','pps','pot','odp','ott','fodt','fods','fodp','wps','pptm','ppsm','potm','otp','xlt','xltx','xltm','ots'}
    info['CFBundleDocumentTypes']=[{'CFBundleTypeName':'AE Studio supported documents','CFBundleTypeRole':'Editor','LSHandlerRank':'Alternate','CFBundleTypeExtensions':sorted(extensions)}]
    info_path.write_bytes(plistlib.dumps(info))
    # Ad-hoc signatures allow execution; they are not Apple publisher notarization.
    run(['codesign','--force','--deep','--sign','-',app])
    source=SUITE/'Source';shutil.copytree(SOURCE,source/'AE Studio',ignore=shutil.ignore_patterns('node_modules','__pycache__','*.pyc','google-desktop.json'))
    shutil.copytree(ROOT,source/'macos-build',ignore=shutil.ignore_patterns('build','checks','__pycache__'))
    collect_sources(py,source/'PDF dependencies')
    fetch(LOCK['mupdf-source'],source/'PDF dependencies/mupdf-1.27.2-source.tar.gz')
    (BUILD/'runtime-downloads.json').write_text(json.dumps(RECORDS,indent=2))
    run([py,'-m','pip','freeze'],stdout=(BUILD/'pdf-resolved-lock.txt').open('w'))
    run([lpy,'-m','pip','freeze'],stdout=(BUILD/'language-resolved-lock.txt').open('w'))
    print('Mac companion assembled:',app,flush=True)
if __name__=='__main__':main()
