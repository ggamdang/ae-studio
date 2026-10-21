"""Representative offline import/export tests against pinned native executables."""
import hashlib, json, math, os, pathlib, struct, subprocess, time, wave, zipfile, zlib
ROOT = pathlib.Path(__file__).resolve().parent
QA = ROOT/'checks'/'exports'; QA.mkdir(parents=True, exist_ok=True)
IN = QA/'inputs 한글'; IN.mkdir(exist_ok=True)
OUT = QA/'outputs 한글'; OUT.mkdir(exist_ok=True)
RESULTS=[]
def record(name, app, args, expected=(), contains=None, timeout=75):
    start=time.time(); r={'name':name,'app':app,'args':[str(a) for a in args]}
    exe=pathlib.Path(json.loads((ROOT/'build/native-index.json').read_text())[app]['cli'])
    try:
        p=subprocess.run([str(exe),*[str(a) for a in args]],capture_output=True,timeout=timeout,cwd=QA,creationflags=0)
        out=(p.stdout+p.stderr).decode('utf-8','replace')
        (QA/(name+'.log')).write_text(out,encoding='utf-8')
        r.update(exit=p.returncode,output=out[:1200])
        assert p.returncode==0, 'nonzero exit'
        for f in expected:
            assert f.is_file() and f.stat().st_size>20, 'missing/empty '+str(f)
            if f.suffix in ('.docx','.xlsx','.pptx','.odt'):
                with zipfile.ZipFile(f) as z: assert z.testzip() is None
            if f.suffix=='.png': assert f.read_bytes()[:8]==b'\x89PNG\r\n\x1a\n'
            if f.suffix=='.pdf': assert f.read_bytes()[:5]==b'%PDF-'
        if contains: assert contains in out, 'expected content absent'
        r['ok']=True
    except Exception as e:
        r.update(ok=False,error=str(e))
    r['seconds']=round(time.time()-start,2); RESULTS.append(r)
    (QA/'result.json').write_text(json.dumps({'ok':all(x['ok'] for x in RESULTS),'checks':RESULTS},indent=2,ensure_ascii=False),encoding='utf-8')
    print(name,'PASS' if r['ok'] else 'FAIL '+r.get('error',''),flush=True)

(IN/'sample.txt').write_text('AE Studio native export test\nEnglish and 한국어\nOriginal source must remain unchanged.\n',encoding='utf-8')
(IN/'sheet.csv').write_text('Item,Quantity,Price\nApples,3,1200\nBooks,2,9000\n',encoding='utf-8')
(IN/'drawing.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#e9eef6"/><circle cx="160" cy="100" r="60" fill="#19735a"/><text x="45" y="205" font-size="24">AE Studio native test</text></svg>',encoding='utf-8')
def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
rows=b''.join(b'\0'+b''.join(bytes((x%256,y%256,(x+y)%256,255)) for x in range(160)) for y in range(120))
(IN/'image.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',160,120,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b''))
with wave.open(str(IN/'tone.wav'),'wb') as w:
    w.setparams((1,2,24000,0,'NONE','not compressed')); w.writeframes(b''.join(struct.pack('<h',int(1500*math.sin(2*math.pi*220*i/24000))) for i in range(24000)))
originals={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in IN.iterdir()}

for ext in ['docx','pdf','odt','rtf','html','md','png']:
    f=OUT/('document.'+ext); record('word-'+ext,'wordcraft',['convert',IN/'sample.txt',f],[f])
record('word-docx-reopen','wordcraft',['text',OUT/'document.docx'],contains='AE Studio native export test')
record('pdf-read-word-export','pdfcraft',['text',OUT/'document.pdf'],contains='AE Studio native export test')
for ext in ['xlsx','json','html','tsv']:
    f=OUT/('sheet.'+ext); record('grid-'+ext,'gridcraft',['convert',IN/'sheet.csv',f],[f])
record('grid-xlsx-reopen','gridcraft',['cat',OUT/'sheet.xlsx','--range','A1:C3'],contains='Apples')
record('grid-formula','gridcraft',['eval','=SUM(1,2,3)'],contains='6')
record('deck-create','deckcraft',['run','--cmd','slide.new={"title":"AE Studio native test"}','--save',OUT/'slides.deckcraft'],[OUT/'slides.deckcraft'])
for ext in ['pptx','pdf']:
    f=OUT/('slides.'+ext);record('deck-'+ext,'deckcraft',['convert',OUT/'slides.deckcraft',f],[f])
record('deck-pptx-reopen','deckcraft',['info',OUT/'slides.pptx'],contains='AE Studio native test')
for ext in ['jpg','webp','tif','psd','pcraft']:
    f=OUT/('image.'+ext); record('photo-'+ext,'photocraft',['convert',IN/'image.png',f],[f])
record('photo-psd-reopen','photocraft',['info',OUT/'image.psd'],contains='160')
for ext in ['vectorcraft','pdf','png','svgz','eps']:
    f=OUT/('drawing.'+ext);record('vector-'+ext,'vectorcraft',['convert',IN/'drawing.svg',f],[f])
record('vector-native-reopen','vectorcraft',['info',OUT/'drawing.vectorcraft'],contains='artboards')
record('light-jpg','lightcraft',['render',IN/'image.png','-o',OUT/'developed.jpg','--set','light.exposure=0.3'],[OUT/'developed.jpg'])
record('design-pdf','designcraft',['run','--sample','--export',OUT/'layout.pdf'],[OUT/'layout.pdf'])
record('fig-native','figcraft',['convert',IN/'drawing.svg',OUT/'design.figcraft'],[OUT/'design.figcraft'])
record('fig-png','figcraft',['render',OUT/'design.figcraft','-o',OUT/'design.png'],[OUT/'design.png'])
record('cad-dxf','cadcraft',['sample','bracket',OUT/'drawing.dxf'],[OUT/'drawing.dxf'])
record('cad-pdf','cadcraft',['convert',OUT/'drawing.dxf',OUT/'cad.pdf'],[OUT/'cad.pdf'])
record('sound-flac','soundcraft',['convert',IN/'tone.wav',OUT/'tone.flac'],[OUT/'tone.flac'])
record('sound-flac-reopen','soundcraft',['info',OUT/'tone.flac'],contains='24000')
record('sound-session','soundcraft',['run','--demo','--save',OUT/'session.scraft'],[OUT/'session.scraft'])
record('film-import','filmcraft',['--save-as',OUT/'film.fcproj','import',IN/'image.png'],[OUT/'film.fcproj'])
record('film-project','filmcraft',['--project',OUT/'film.fcproj','--save','exec','file.newSequence',json.dumps({'name':'Verified image clip','fromItem':1})],[OUT/'film.fcproj'])
record('film-frame','filmcraft',['--project',OUT/'film.fcproj','render','--seconds','0.1','--out',OUT/'film.png','--scale','1'],[OUT/'film.png'])
record('film-video','filmcraft',['--project',OUT/'film.fcproj','export',OUT/'film.mp4','--start','0','--end','0.3','--scale','1','--no-audio'],[OUT/'film.mp4'])
record('effect-frame','effectcraft',['--demo','render-frame','--time','0','--max-side','320','--out',OUT/'motion.png'],[OUT/'motion.png'])
record('pdf-edit','pdfcraft',['edit',OUT/'document.pdf','--out',OUT/'rotated.pdf','--rotate','1:90'],[OUT/'rotated.pdf'])
record('pdf-combine','pdfcraft',['combine',OUT/'document.pdf',OUT/'rotated.pdf','--out',OUT/'combined.pdf'],[OUT/'combined.pdf'])
record('pdf-render','pdfcraft',['render',OUT/'combined.pdf','--page','1','--out',OUT/'pdf-page.png'],[OUT/'pdf-page.png'])
assert originals=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in IN.iterdir()}
print(json.dumps({'passed':sum(r['ok'] for r in RESULTS),'total':len(RESULTS),'originalsUnchanged':True}),flush=True)

raise SystemExit(0 if all(r["ok"] for r in RESULTS) else 1)
