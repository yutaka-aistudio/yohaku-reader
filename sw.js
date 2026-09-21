const CACHE='yohaku-shell-7bc5bf7fa01c0ec8';
const SHELL=['./','./index.html','./deployment.js','./style.css','./core.js','./drive.js','./progress.js','./app.js','./ai-ui.js','./mobile.js','./icon.svg','./icon-192.png','./icon-512.png','./apple-touch-icon.png','./manifest.webmanifest'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('yohaku-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const u=new URL(event.request.url);
  if(event.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.includes('/api/'))return;
  if(!SHELL.map(p=>new URL(p,self.registration.scope).href).includes(u.href)&&event.request.mode!=='navigate')return;
  event.respondWith(fetch(event.request).then(r=>{if(!r.ok)throw new Error('offline');return r;}).catch(()=>caches.match(event.request).then(r=>r|| (event.request.mode==='navigate'?caches.match(new URL('./index.html',self.registration.scope).href):Response.error()))));
});
