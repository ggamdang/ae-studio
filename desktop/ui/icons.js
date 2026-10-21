'use strict';
const iconPaths={
 home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
 panel:'M3 4h18v16H3zM9 4v16',
 folder:'M3 7V5h6l2 2h10v13H3z',
 save:'M4 3h13l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8',
 close:'m6 6 12 12M6 18 18 6',
 cloud:'M7 18a5 5 0 1 1 0-10 6 6 0 0 1 11-1 5.5 5.5 0 0 1 0 11z',
 settings:'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
 info:'M12 16v-5M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 sun:'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 moon:'M20.8 13a9 9 0 1 1-9.8-9.8A7 7 0 0 0 20.8 13z',
 monitor:'M3 3h18v14H3zM8 21h8M12 17v4',
 focus:'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5',
 chevron:'m7 14 5-5 5 5'
};
function studioIcon(name){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(iconPaths[name]||iconPaths.info)+'"/></svg>';}
document.querySelectorAll('[data-icon]').forEach(e=>e.innerHTML=studioIcon(e.dataset.icon));
