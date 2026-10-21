const test=require('node:test'),assert=require('node:assert/strict');
const native=require('../mac-native.cjs');
test('native routing covers all catalog entries, case and mounted-volume paths',()=>{
 for(const item of native.catalog)for(const ext of item.extensions)assert(native.route('/Volumes/School Share/한국어 sample.'+ext.toUpperCase()));
 for(const [file,editor] of [['report.docx','wordcraft'],['book.xlsx','gridcraft'],['slides.pptx','deckcraft'],['scan.pdf','pdfcraft'],['image.png','photocraft'],['project.ecproj','effectcraft'],['page.hwpx','wordcraft']])assert.equal(native.route('/Volumes/School Share/'+file).id,editor);
 assert.equal(native.route('/Volumes/School Share/unknown.unsupported'),null);
 assert.equal(native.route('/Volumes/School Share/lesson.hwp').convert,'hangul');
 assert.equal(native.route('/Volumes/School Share/slides.odp').convert,'pptx');
});
test('native routing does not impose the former WASM size ceiling',()=>{
 assert.equal(native.route('/Volumes/Media/large-film.mp4').maxBytes,undefined);
 assert(native.formats().some(row=>row.extension==='hwp'&&row.open.includes('DOCX')));
});
