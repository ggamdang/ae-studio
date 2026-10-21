"""Use the bundled decoder to verify AVIF import, transparency and preservation."""
import hashlib,json,pathlib,subprocess,sys
from PIL import Image
d,out=map(pathlib.Path,sys.argv[1:]);out.mkdir(parents=True,exist_ok=True)
source=out/'image 한글.avif'
image=Image.new('RGBA',(64,32),(40,100,180,255))
for x in range(32):
    for y in range(32):image.putpixel((x,y),(0,0,0,0))
image.save(source,format='AVIF')
before=hashlib.sha256(source.read_bytes()).hexdigest()
script="require(require('node:path').join(process.argv[1],'integrations/raster-convert.cjs')).convertRaster({path:process.argv[2]},process.argv[3]).then(p=>console.log(JSON.stringify(p))).catch(e=>{console.error(e);process.exitCode=1})"
p=subprocess.run(['node','-e',script,str(d),str(source),str(out)],capture_output=True,text=True,check=True,timeout=90)
destination=pathlib.Path(json.loads(p.stdout))
with Image.open(destination) as result:
    assert result.size==(64,32) and result.mode=='RGBA'
    assert result.getpixel((2,2))[3]==0 and result.getpixel((60,2))[3]==255
assert hashlib.sha256(source.read_bytes()).hexdigest()==before
print(json.dumps({'ok':True,'avifToPNG':True,'transparencyPreserved':True,'originalPreserved':True}))
