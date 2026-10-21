"""Prepare/build the local adapter from the included sanitized, MIT/Apache source."""
import pathlib, shutil, re, json, difflib, os, argparse, subprocess
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--install',action='store_true',help='Install pinned npm dependencies without install scripts')
parser.add_argument('--build',action='store_true',help='Compile the prepared frontend')
args=parser.parse_args()
HERE=pathlib.Path(__file__).resolve().parent
WORK=pathlib.Path(os.environ.get('ARTCRAFT_BUILD_DIR',HERE.parent.parent/'artcraft-v03')).resolve()
UP=pathlib.Path(os.environ.get('ARTCRAFT_WORKTREE',WORK/'upstream/artcraft-main')).resolve()
PRISTINE=HERE/'upstream'
WORK.mkdir(parents=True,exist_ok=True)
if UP==PRISTINE or PRISTINE in UP.parents:raise ValueError('Build directory must be separate from the pristine source.')
shutil.copytree(PRISTINE,UP,dirs_exist_ok=True)
FRONT=UP/'frontend'
APP=FRONT/'apps/artcraft'
SRC=APP/'app/src'
patches=[]
patched_files=set()
def patch(rel,fn):
 p=FRONT/rel; before=(PRISTINE/'frontend'/rel).read_text(encoding='utf8') if rel not in patched_files else p.read_text(encoding='utf8'); after=fn(before); patched_files.add(rel)
 if after!=before:
  p.write_text(after,encoding='utf8')
  patches.extend(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/frontend/'+rel,tofile='b/frontend/'+rel))
for p in (HERE/'src').iterdir():
 shutil.copy2(p,SRC/p.name)
# Run with the original renderer components, replacing only host side services.
html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ArtCraft local workspace</title></head><body><div id="root"></div><script type="module" src="/src/local-workspace.tsx"></script></body></html>'
(APP/'app/index.html').write_text(html,encoding='utf8')
(SRC/'sound-shim.ts').write_text('export const SoundManager = new Proxy({}, {get:()=>async()=>{}});\n',encoding='utf8')
patch('libs/components/pagedraw/src/lib/PageDraw.tsx',lambda s:s.replace('  // Pre-bake the composite File on idle','  useEffect(() => { (window as any).__artcraftCanvasExport = getCompositeCanvasFile; return () => { delete (window as any).__artcraftCanvasExport; }; }, [getCompositeCanvasFile]);\n\n  // Pre-bake the composite File on idle') if '__artcraftCanvasExport' not in s else s)
# The mask itself is a local editing feature, irrespective of generation model.
patch('libs/components/pagedraw/src/lib/PageDraw.tsx',lambda s:s.replace('supportsMaskTool={supportsMaskedInpainting}','supportsMaskTool={true}').replace('showMaskLayer={supportsMaskedInpainting}','showMaskLayer={true}'))
# The local workspace has no generation service; remove its unavailable prompt/model form.
patch('libs/components/pagedraw/src/lib/PageDraw.tsx',lambda s:re.sub(r'      <div\s+className=\{`preserve-aspect-ratio fixed inset-x-0 bottom-0 z-10.*?</div>\s+(?=<SideToolbar)', '',s,flags=re.S))
# Imported/restored local layers have embedded URLs, rather than a browser File.
patch('libs/components/pagedraw/src/lib/stores/SceneState.ts',lambda s:s.replace('if (!firstNode || !firstNode.imageFile)', 'if (!firstNode || (!firstNode.imageFile && !firstNode.imageUrl))').replace('const base64Image = await convertFileToBase64(firstNode.imageFile);','const base64Image = firstNode.imageUrl ? firstNode.imageUrl : await convertFileToBase64(firstNode.imageFile!);'))
demo='libs/components/pagescene/src/lib/signals/demoAssets/'
patch(demo+'demoCharacterItems.ts',lambda s:'import {AssetType} from "../../enums";\nexport const demoCharacterItems = [{version:1,media_id:"studio-mannequin",type:AssetType.CHARACTER,name:"Studio mannequin",thumbnail:"/local-assets/mannequin.svg",media_type:"glb"}];\nexport const devCharacterItems = demoCharacterItems;\n')
for name,export in [('demoAnimationItems.ts','demoAnimationItems'),('demoMemeItems.ts','demoMemeItems')]:
 patch(demo+name,lambda s,export=export:'export const '+export+' = [];\n')
patch(demo+'demoAssets.ts',lambda s:re.sub(r'export const demoObjectItems: MediaItem\[\] = \[.*?\];','export const demoObjectItems: MediaItem[] = [];',s,flags=re.S))
patch(demo+'demoSkyboxItems.ts',lambda s:'import {AssetType} from "../../enums";\nexport const demoSkyboxItems = [{version:1,media_id:"SKY::m_1",type:AssetType.SKYBOX,name:"Studio gray",thumbnail:"/local-assets/gray.svg"},{version:1,media_id:"SKY::m_2",type:AssetType.SKYBOX,name:"Black",thumbnail:"/local-assets/black.svg"}];\n')
# Replace all cubemap packs with flat-color environments, including old saved scenes.
patch('libs/components/pagescene/src/lib/engine/scene.ts',lambda s:re.sub(r'const texture = loader\.load\(\[.*?\]\);', 'const texture = new THREE.Color("#282828");',s,flags=re.S))
# Pose persistence must support arbitrary GLB bone hierarchies, not only one demo model.
patch('libs/components/pagescene/src/lib/engine/KinHelpers/BoneJSONHelper.ts',lambda s:(HERE/'patches/BoneJSONHelper.ts').read_text(encoding='utf8'))
patch('libs/components/pagescene/src/lib/proxy/storyteller_proxy_scene.ts',lambda s:s.replace('t.startsWith("m_")','(t.startsWith("m_") || t.startsWith("local-") || t === "studio-mannequin")').replace('token.includes("m_")','(token.includes("m_") || token.startsWith("local-") || token === "studio-mannequin")'))
# Source public resources contain third-party exclusions. Copy a strict allow-list.
pub=WORK/'public';pub.mkdir(exist_ok=True)
origin=APP/'app/public'
for rel in ['resources/shapes','resources/fonts','resources/placeholders','resources/images/services','jsm']:
 if (origin/rel).exists():shutil.copytree(origin/rel,pub/rel,dirs_exist_ok=True)
(pub/'local-assets').mkdir(exist_ok=True)
shutil.copy2(HERE/'assets/mannequin.glb',pub/'local-assets/mannequin.glb')
for name,color in [('gray','#282828'),('black','#000000')]:
 (pub/f'local-assets/{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="{color}"/></svg>')
(pub/'local-assets/mannequin.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="180" viewBox="0 0 160 180"><rect width="160" height="180" fill="#273448"/><g fill="none" stroke="#79b8dc" stroke-width="15" stroke-linecap="round"><path d="M80 55v55m0-42L30 88m50-20l50 20m-50 22l-23 48m23-48l23 48"/></g><circle cx="80" cy="32" r="16" fill="#c8a77b"/></svg>')
config='''import {defineConfig} from 'vite';
import paths from 'vite-tsconfig-paths';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'node:path';
export default defineConfig({root:path.resolve(__dirname,'app'),publicDir:PUBLIC,build:{outDir:OUT,emptyOutDir:true,target:'es2022',chunkSizeWarningLimit:15000},plugins:[paths({projects:[path.resolve(__dirname,'../../tsconfig.base.json')]}),wasm(),topLevelAwait()],resolve:{dedupe:['react','react-dom','@preact/signals-core','@preact/signals-react'],alias:[{find:/^@tauri-apps\\/.+$/,replacement:path.resolve(__dirname,'app/src/tauri-shim.ts')},{find:'@storyteller/soundboard',replacement:path.resolve(__dirname,'app/src/sound-shim.ts')}]}});
'''.replace('PUBLIC',json.dumps(str(pub))).replace('OUT',json.dumps(str(HERE/'renderer')))
(APP/'vite.unified.config.ts').write_text(config,encoding='utf8')
if patches:
 with (HERE/'upstream-local.patch').open('w',encoding='utf8') as f:f.writelines(patches)
print(json.dumps({'frontend':str(FRONT),'app':str(APP),'renderer':str(HERE/'renderer'),'patch_lines':len(patches)}))
if args.install:
 subprocess.run(['npm.cmd' if os.name=='nt' else 'npm','ci','--ignore-scripts','--no-audit','--no-fund'],cwd=FRONT,check=True)
if args.build:
 subprocess.run([str(FRONT/'node_modules/.bin'/('vite.cmd' if os.name=='nt' else 'vite')),'build','--config','vite.unified.config.ts'],cwd=APP,check=True)
