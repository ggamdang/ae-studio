"""Keep test evidence without scratch profiles, auth helpers or control tokens."""
import pathlib,shutil
ROOT=pathlib.Path(__file__).resolve().parent
def collect(destination):
    destination.mkdir(parents=True,exist_ok=True)
    excluded={'profile','google-helper','roaming','local','ProviderHelpers','AccountHelpers'}
    source=ROOT/'checks'
    for file in source.rglob('*') if source.exists() else []:
        relative=file.relative_to(source)
        if not file.is_file() or any(p in excluded for p in relative.parts) or file.name.startswith('control'):continue
        if file.suffix not in {'.json','.log','.png','.pdf'}:continue
        target=destination/'checks'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
    for name in ['native-index.json','runtime-downloads.json','format-guide.json','pdf-resolved-lock.txt','language-resolved-lock.txt']:
        file=ROOT/'build'/name
        if file.is_file():shutil.copy2(file,destination/name)
if __name__=='__main__':collect(ROOT/'diagnostics')
