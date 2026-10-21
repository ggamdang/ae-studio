# Local PDF engine API (v0.2)

`const pdf = require('./pdf/bridge.cjs'); await pdf.run(action, options)`.
`await pdf.capabilities()` reports installed engines and supported actions.

Every action accepts `inputs: [absolutePath]` (multiple for merge / images-to-pdf).
Editing actions require `outputDir` (an existing absolute directory). A unique
`Unified-PDF-<action>-<timestamp>-<random>` subdirectory is created for each job;
inputs and existing output files are never overwritten. `password` unlocks the
input. `passwords: [string,...]` can provide individual merge passwords.

Result: `{ok:true, outputs:[{path,name,bytes}], details:{...}, warnings:[]}`.
Failure: `{ok:false,error:{code,message},outputs:[]}`; passwords are never logged.
Passwords travel only through the child process standard input, never command
arguments or environment variables. No network services are used.

| Action | Additional options (all page numbers are 1-based) |
|---|---|
| `inspect` | One input; no outputDir. Details: pageCount, encrypted, needsPassword, pages:[{page,width,height,rotation}], fields:[{name,type,value,page,rect}], metadata. A password-locked file returns needsPassword without failure. |
| `preview` | `page:1`, `maxWidth:1100` (200–2000); no outputDir. Details: page,pageCount,width,height,pngBase64. Dimensions are displayed PDF points; pointer positions map directly to these points. |
| `unlock` | Input password, if required. No guessing or unknown-password recovery. Owner restrictions on a file that opens with a blank password can be removed. |
| `protect` | `newPassword` (required), optional `ownerPassword`; `permissions:{print:true,copy:true,modify:false,annotate:true,forms:true}`. AES-256. |
| `merge` | At least 2 PDF inputs; input order is output order. |
| `split` | `every:1`; alternatively `groups:["1-3","4-6"]`. One output per group. |
| `extract` | `pages:"1-3,5"` (required). |
| `reorder` | `pages:"3,1,2"` (required); repeated pages allowed. Descending ranges supported. |
| `rotate` | `pages:""` means all; `angle:90` must be 90,180,270,-90. |
| `compress` | Lossless cleanup/stream compression. Reduction is not guaranteed. |
| `images-to-pdf` | PNG/JPEG/WebP/TIFF/BMP inputs; optional `pageSize:"image"` (default) or `"A4"`; `margin:24` for A4. |
| `pdf-to-images` | `pages:""`, `dpi:144` (72–300), `format:"png"` or `"jpg"`. One image per page. |
| `watermark` | `text` required, `pages:""`, `fontSize:36`, `opacity:0.25`, `color:"#777777"`. Centered on each selected page. |
| `page-numbers` | `pages:""`, `template:"{page} / {total}"`, `start:1`, `fontSize:10`, `position:"bottom-center"` (or bottom-left, bottom-right, top-center). |
| `redact` | `boxes:[{page:1,x0,y0,x1,y1}]`, optional `searchText` or `terms:[string]`, `pages:""` restricts term search; `confirmed:true` required. Removes actual text/image/vector content and scrubs document metadata, attachments, scripts, form values and hidden text. Coordinates match preview. Defaults to secure flattened output (`rasterize:true`, `dpi:150`) to exclude hidden content; `rasterize:false` retains vector content after actual PDF redaction. |
| `fill-form` | `values:{fieldName:value}`; optional `flatten:false`. Inspect supplies field names. |
| `sign` | `signaturePath` (absolute PNG/JPEG file), `page:1`, `box:{x0,y0,x1,y1}` in displayed PDF points. Visual signature placement only, not a certificate signature. |
| `extract-text` | `pages:""`. Writes UTF-8 text. |
| `ocr` | `pages:""`, `dpi:150` (72–300). Bundled offline RapidOCR models support English/Chinese; no Korean OCR claim. Adds a searchable text layer to selected pages. |
| `office-to-pdf` | DOC/DOCX/XLS/XLSX/PPT/PPTX/ODT/ODS/ODP/RTF input. Requires detected local LibreOffice; errors clearly if unavailable. No approximate renderer presented as faithful conversion. |
| `remove-pages` | `pages` required. Rejects removing every page. |
| `repair` | Rewrites recoverable PDF structure; irrecoverably corrupt files fail clearly. |
| `crop` | `box:{x0,y0,x1,y1}`, `pages:""`. Changes visible boundary, not secure removal. |
| `add-text` | `page:1`, `box`, `text`, `fontSize:14`, `color:"#222222"`. |
| `annotate` | `page:1`, `box`, `text`, `kind:"note"` (or highlight, rectangle), `color:"#222222"`. |
| `extract-images` | `pages:""`; exports embedded raster resources. |
| `compare` | Exactly 2 PDF inputs; optional `secondPassword`. Writes text diff and changed-page visual difference PNGs; `details.visuallyChangedPages`. |
| `summarize` | `sentences:7` (1–50), `pages:""`. Offline sentence extraction using word frequency; no AI/model downloads. |
| `extract-structured` | `format:"json"` or `"markdown"`, `pages:""`. Text blocks and coordinates, not AI semantic parsing. Alias: extract-layout. |
| `pdf-to-docx` | `pages:""`. Uses pdf2docx for editable layout reconstruction; scans need OCR first. Alias: pdf-to-word. |
| `pdf-to-pptx` | `pages:""`, `dpi:144`; one rendered page image per slide, image-based not editable source objects. |
| `pdf-to-xlsx` | `pages:""`; detected tables to worksheets, other pages to text lines. Source strings never become spreadsheet formulas. Alias: pdf-to-excel. |
| `recover-password` | `candidates:[string]` (1–1000), `maxSeconds:30` (1–60). Tests only supplied candidates. Matching candidate index returned; never password text. No guarantee or built-in cracking lists. |
| `scan-to-pdf` | Multiple images, same options as images-to-pdf plus `grayscale:false`; local auto-contrast correction. |
| `html-to-pdf` | One .html/.htm file, UTF-8, at most 5 MB; local static text/CSS only, no external assets/scripts/URLs. |
| `pdfa`, `translate`, `ai-extract` | Explicitly unavailable capability messages. No fake PDF/A metadata, automatic online translation, or unbundled Docling models. |

For a read-only preview, both dimensions and all box coordinates use the page
as displayed after its stored rotation. The engine maps back to unrotated PDF
coordinates before editing. Input filenames may contain Unicode. Arbitrary
program execution, shell arguments, network URLs and output overwrites are not
part of the API.
