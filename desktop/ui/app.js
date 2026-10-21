let state,filter='All';
const $=id=>document.getElementById(id);
function button(text,handler,className){const el=document.createElement('button');el.textContent=text;if(className)el.className=className;el.onclick=handler;return el;}
async function open(id){const module=state.modules.find(m=>m.id===id);if(module.available===false){$('status-text').textContent=module.description;return;}if(!module.installed){$('setup').scrollIntoView({behavior:'smooth'});$('status-text').textContent='Download the editors to finish setup.';return;}$('loading').hidden=false;$('loading-name').textContent='Opening '+module.name+'…';try{render(await window.studio.open(id));}catch(e){$('status-text').textContent=e.message;}$('loading').hidden=true;}
function render(next){state=next;renderAppearance();const active=state.modules.find(m=>m.id===state.active);$('page-title').textContent=active?.name||'Home';$('section-label').textContent=active?'WORKSPACE':'YOUR WORKSPACE';$('overview').hidden=!!active;$('editor-actions').hidden=!active;$('home').classList.toggle('selected',!active);$('status-text').textContent=state.error||(active?`${active.engine} · local editor`:'Ready when you are');$('folder-label').textContent=state.saveFolder?state.saveFolder.split(/[\\/]/).pop():'Choose export folder';$('choose-folder').title=state.saveFolder||'Choose a default folder for exports from every editor';
  document.querySelectorAll('#editor-actions [data-action]').forEach(button=>{button.hidden=!!active?.nativeTool;});
  $('app-version').textContent=`Version ${state.version} · Preview`;$('open-file').disabled=state.opening;$('open-file').querySelector('span:last-child').textContent=state.opening?'Opening…':'Open file';$('notice').hidden=!state.error;$('notice-text').textContent=state.error||'';document.body.classList.toggle('has-error',!!state.error);$('status-text').textContent=state.openMessage||(active?`${active.engine} · local editor`:'Drop a file here, or choose Open file.');if(active?.currentFile){$('page-title').textContent=active.currentFile;$('section-label').textContent=`${active.name}`;}$('page-title').title=$('page-title').textContent;
  $('setup').hidden=state.modules.every(m=>m.available===false||m.installed);$('install-editors').disabled=state.installing;$('install-editors').textContent=state.installing?'Setting up…':'Download editors';$('setup-message').textContent=state.error||state.setupMessage;
  const nav=$('navigation');nav.replaceChildren();for(const group of ['Office & PDF','Image & design','Video & motion']){const label=document.createElement('div');label.className='nav-group';label.textContent=group;nav.append(label);for(const m of state.modules.filter(m=>m.group===group)){const el=button('',()=>open(m.id),'nav-item'+(state.active===m.id?' selected':''));const symbol=document.createElement('span');symbol.className='nav-symbol';symbol.style.color=m.color;symbol.textContent=m.symbol;const label=document.createElement('span');label.className='nav-label';label.textContent=m.name;el.title=m.name;el.setAttribute('aria-label',m.name);el.setAttribute('aria-current',state.active===m.id?'page':'false');el.append(symbol,label);if(m.opened){const dot=document.createElement('span');dot.className='opened-dot';el.append(dot);}nav.append(el);}}
  const opened=state.modules.filter(m=>m.opened);$('open-workspaces').hidden=!opened.length;$('workspace-tabs').replaceChildren(...opened.map(m=>{const b=button(m.name,()=>open(m.id),'workspace-tab');b.style.setProperty('--color',m.color);return b;}));
  const grid=$('tool-grid');grid.replaceChildren();for(const m of state.modules.filter(m=>filter==='All'||m.group===filter)){const el=button('',()=>open(m.id),'tool-card');el.style.setProperty('--color',m.color);for(const [tag,cls,text] of [['span','tool-icon',m.symbol],['span','arrow','↗'],['h4','',m.name],['p','',m.description],['p','formats',m.formats]]){const child=document.createElement(tag);child.className=cls;child.textContent=text;el.append(child);}grid.append(el);}
  const list=$('exports');list.replaceChildren();if(!state.exports.length){const p=document.createElement('p');p.className='empty';p.textContent='Your saved exports will appear here.';list.append(p);}for(const item of state.exports.slice(0,5)){const b=button('',()=>window.studio.revealExport(item.id),'export-row');const name=document.createElement('span');name.textContent=item.name;const date=document.createElement('small');date.textContent=new Date(item.when).toLocaleDateString()+' ↗';b.append(name,date);list.append(b);}}
$('install-editors').onclick=async()=>render(await window.studio.install());$('home').onclick=async()=>render(await window.studio.home());$('choose-folder').onclick=async()=>render(await window.studio.chooseFolder());$('close-editor').onclick=()=>window.studio.closeEditor();$('notices').onclick=()=>window.studio.notices();document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>window.studio.shortcut(b.dataset.action));document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));render(state);});window.studio.onState(render);window.studio.state().then(render);
const showFailure=e=>{$('notice').hidden=false;$('notice-text').textContent=e.message||String(e);};
$('open-file').onclick=()=>window.studio.openFiles().then(r=>r.state&&render(r.state)).catch(showFailure);
$('dismiss-error').onclick=()=>window.studio.dismissError().then(render).catch(showFailure);
$('settings').onclick=async()=>{
  const formats=$('file-formats');formats.replaceChildren();
  for(const group of (state.fileCapabilities.formats||[])){const row=document.createElement('p');const label=document.createElement('strong');label.textContent=group.name+': ';row.append(label,document.createTextNode(group.extensions.map(e=>'.'+e).join(', ')+(group.limitMiB?` · up to ${group.limitMiB} MB`:'')));formats.append(row);}
  await window.studio.shellDialog(true);$('settings-dialog').showModal();
  formatRows=await window.studio.formats();renderFormats();
};
let formatRows=[];
function renderFormats(){const body=document.querySelector('#format-table tbody');body.replaceChildren();const query=$('format-search').value.toLowerCase().trim();for(const row of formatRows.filter(r=>!query||JSON.stringify(r).toLowerCase().includes(query))){const tr=document.createElement('tr');for(const text of ['.'+row.extension,row.workspace,row.open+'; '+row.edit,row.exports]){const td=document.createElement('td');td.textContent=text;tr.append(td);}const detail=document.createElement('small');detail.textContent=row.notes+' '+row.verification;tr.lastChild.append(detail);body.append(tr);}}
$('format-search').oninput=renderFormats;
$('settings-dialog').addEventListener('close',()=>window.studio.shellDialog(false));
$('close-settings').onclick=()=>$('settings-dialog').close();
$('registration-help').onclick=()=>window.studio.registrationHelp().catch(showFailure);
$('windows-defaults').onclick=()=>window.studio.windowsDefaults().catch(showFailure);
$('user-data').onclick=()=>window.studio.userData().catch(showFailure);
window.studio.installation().then(info=>{
  $('registration-help').hidden=info.installed;
  if(info.platform==='darwin'){$('windows-defaults').textContent='How to choose a default app';$('installation-note').textContent='AE Studio and its editors are available through Finder Open With. To change a default, select a file in Finder, choose Get Info, then Open with and Change All. Existing defaults are preserved.';$('local-ai-note').textContent=info.localAI?'Local AI is installed.':'Open AI Studio to set up the free local model, or connect to an existing local ComfyUI server.';return;}
  $('installation-note').textContent=info.installed
    ? 'The installer added the file types you selected to Windows Open with. Choose your defaults below. Run Setup again to change the registered categories or add local AI. Your personal projects and settings are kept separately and preserved when you uninstall.'
    : 'For this portable copy, register Open with using the included script before choosing defaults. Keep the application folder in a permanent location.';
  $('local-ai-note').textContent=info.localAI?'Free local image generation is installed. Open AI Studio to get started.':'Free local image generation is not installed. Install the optional Local AI add-on to add it to this same app.';
}).catch(showFailure);

function renderAppearance(){
 const p=state.preferences||{theme:'system'};document.documentElement.dataset.theme=state.resolvedTheme||'light';
 document.body.classList.toggle('sidebar-collapsed',!!p.sidebarCollapsed);document.body.classList.toggle('toolbar-collapsed',!!p.toolbarCollapsed);document.body.classList.toggle('in-editor',!!state.active);
 $('toggle-sidebar').setAttribute('aria-expanded',String(!p.sidebarCollapsed));$('toggle-sidebar').title=(p.sidebarCollapsed?'Expand':'Collapse')+' sidebar (Ctrl+Shift+B)';
 $('toggle-toolbar').setAttribute('aria-expanded',String(!p.toolbarCollapsed));$('toggle-toolbar').title=(p.toolbarCollapsed?'Expand':'Collapse')+' toolbar (Ctrl+Shift+T)';$('toggle-toolbar').setAttribute('aria-label',$('toggle-toolbar').title);
 $('sidebar-setting').checked=!!p.sidebarCollapsed;$('toolbar-setting').checked=!!p.toolbarCollapsed;
 document.querySelectorAll('[data-theme]').forEach(b=>{b.classList.toggle('selected',b.dataset.theme===p.theme);b.setAttribute('aria-pressed',String(b.dataset.theme===p.theme));});
 $('theme-toggle').title='Appearance: '+p.theme+' — click to switch';$('theme-toggle').innerHTML=studioIcon(state.resolvedTheme==='dark'?'moon':'sun');
 $('focus-workspace').setAttribute('aria-pressed',String(!!p.sidebarCollapsed&&!!p.toolbarCollapsed));
}
const appearanceChange=patch=>window.studio.appearance(patch).then(render).catch(showFailure);
$('toggle-sidebar').onclick=()=>appearanceChange({sidebarCollapsed:!state.preferences.sidebarCollapsed});
$('toggle-toolbar').onclick=()=>appearanceChange({toolbarCollapsed:!state.preferences.toolbarCollapsed});
$('focus-workspace').onclick=()=>{const compact=!(state.preferences.sidebarCollapsed&&state.preferences.toolbarCollapsed);appearanceChange({sidebarCollapsed:compact,toolbarCollapsed:compact});};
$('theme-toggle').onclick=()=>{const choices=['system','light','dark'];appearanceChange({theme:choices[(choices.indexOf(state.preferences.theme)+1)%choices.length]});};
document.querySelectorAll('[data-theme]').forEach(b=>b.onclick=()=>appearanceChange({theme:b.dataset.theme}));
$('sidebar-setting').onchange=e=>appearanceChange({sidebarCollapsed:e.target.checked});$('toolbar-setting').onchange=e=>appearanceChange({toolbarCollapsed:e.target.checked});
$('hero-open').onclick=()=>$('open-file').click();$('explore-tools').onclick=()=>document.querySelector('.tools-section').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});$('home-support').onclick=()=>$('settings').click();
