const modules = [
  {id:'wordcraft',name:'Documents',engine:'WordCraft',group:'Office & PDF',symbol:'W',color:'#435abe',description:'Write, format, and publish documents.',formats:'DOCX · ODT · RTF · PDF export'},
  {id:'gridcraft',name:'Sheets',engine:'GridCraft',group:'Office & PDF',symbol:'G',color:'#26775d',description:'Work with cells, formulas, and charts.',formats:'XLSX · CSV · TSV'},
  {id:'deckcraft',name:'Slides',engine:'DeckCraft',group:'Office & PDF',symbol:'D',color:'#b55538',description:'Shape ideas into a presentation.',formats:'PPTX · PDF export'},
  {id:'pdfcraft',name:'PDF',engine:'PdfCraft',group:'Office & PDF',symbol:'P',color:'#b3454c',description:'Read, annotate, and organize PDF pages.',formats:'PDF'},
  {id:'pdf-tools',name:'PDF Tools',engine:'Local PDF workbench',nativeTool:'pdf',group:'Office & PDF',symbol:'P+',color:'#3c7560',description:'Unlock, merge, convert, redact, fill forms and OCR.',formats:'PDF · Office · scans'},
  {id:'photocraft',name:'Photo',engine:'PhotoCraft',group:'Image & design',symbol:'Ph',color:'#466c9f',description:'Compose images with layers and masks.',formats:'PSD · PNG · JPEG'},
  {id:'vectorcraft',name:'Vector',engine:'VectorCraft',group:'Image & design',symbol:'V',color:'#b07721',description:'Draw paths, shapes, and illustrations.',formats:'SVG · vector artwork'},
  {id:'lightcraft',name:'Develop',engine:'LightCraft',group:'Image & design',symbol:'L',color:'#327d88',description:'Organize photos and develop RAW images.',formats:'RAW · photo library'},
  {id:'designcraft',name:'Layout',engine:'DesignCraft',group:'Image & design',symbol:'De',color:'#92608f',description:'Lay out books, posters, and publications.',formats:'Pages · print layouts'},
  {id:'artcraft',name:'Art',engine:'ArtCraft',bundledWorkspace:true,engineVersion:'source d4e4ac69 (adapted)',group:'Image & design',symbol:'A',color:'#ab6544',description:'Compose on a canvas and build scenes in 3D.',formats:'Canvas · scenes · models'},
  {id:'ai-studio',name:'AI Studio',engine:'SDXL · ComfyUI · ArtCraft',nativeTool:'ai',group:'Image & design',symbol:'AI',color:'#3d6f74',description:'Create free images locally, then open them in ArtCraft.',formats:'Offline SDXL · optional online AI'},
  {id:'filmcraft',name:'Video',engine:'FilmCraft',group:'Video & motion',symbol:'F',color:'#7358a4',description:'Arrange footage, sound, and transitions.',formats:'Video · audio · timelines'},
  {id:'effectcraft',name:'Motion',engine:'EffectCraft',group:'Video & motion',symbol:'E',color:'#8a549f',description:'Compose motion graphics with CPU-rendered effects.',formats:'ECPROJ · PNG · compositions'},
];
if(process.platform==='darwin'){const apps=require('./native-apps.json');for(const m of modules){const app=apps.find(a=>a.id===m.id);if(app){m.engineVersion=app.version;m.description=app.description+' in its own native window.';m.formats=app.extensions.map(e=>e.toUpperCase()).join(' · ');}}for(const a of apps.filter(a=>!modules.some(m=>m.id===a.id)))modules.push({id:a.id,name:a.name,engine:a.name,engineVersion:a.version,group:a.id==='soundcraft'?'Video & motion':'Image & design',symbol:a.name.slice(0,2),color:'#327d88',description:a.description+' in its own native window.',formats:a.extensions.map(e=>e.toUpperCase()).join(' · ')});}
module.exports={modules};
