'use strict';
const $=id=>document.getElementById(id);
const {mergeOps,activeOps,latestPosition,markdown,safeBook}=YohakuCore;
const S={db:null,backend:false,token:'',config:{},books:[],serverBooks:new Set(),book:null,page:0,ops:[],tool:'read',ocr:null,selection:'',
  audioPage:0,playing:false,paused:false,playEpoch:0,audioCache:new Map(),prefetch:new Map(),syncing:false,cloudSyncing:false,recording:false,busy:false};
let deviceId=localStorage.getItem('yohaku-device');if(!deviceId){deviceId=crypto.randomUUID();localStorage.setItem('yohaku-device',deviceId);}
const prefs=JSON.parse(localStorage.getItem('yohaku-prefs')||'{}');
let toastTimer,pageEpoch=0,renderTimer;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function report(error){console.error(error);toast(error.message||String(error));}
function task(message,percent=0){$('taskProgress').hidden=false;$('taskLabel').textContent=message;$('taskBar').value=percent;}
function taskDone(){$('taskProgress').hidden=true;}
function status(message,error=false){$('saveStatus').textContent=message;$('saveStatus').classList.toggle('error',error);}
function escapeXml(s){return String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));}
function button(label,fn,className=''){const b=document.createElement('button');b.textContent=label;b.className=className;b.onclick=()=>Promise.resolve().then(fn).catch(report);return b;}
function bind(id,fn){$(id).addEventListener('click',()=>Promise.resolve().then(fn).catch(report));}
function localBook(book=S.book){return !!book&&S.backend&&S.serverBooks.has(book.id);}
function requireBook(){if(!S.book)throw new Error('先に本を開いてください');return S.book;}
const isLocalPC=!globalThis.YohakuDeployment?.readerOnly&&['127.0.0.1','localhost','[::1]'].includes(location.hostname);
function requirePC(){requireBook();if(!S.backend)throw new Error(isLocalPC?'PC側の余白が停止中か未接続です。「余白を起動.vbs」を開き、左側の「PCへ再接続」を押してください。':'この画面は閲覧専用です。PDFの準備はPC側の余白で行います。');if(!localBook())throw new Error('この本はサンプルまたは持ち出しデータです。左の本棚から元のPDFの本を選んでください。');}
let connectingPC=null;
function showConnection(){
  $('connectionStatus').textContent=S.backend?'● PC接続済み · 原本は変更しません':isLocalPC?'● PCサーバー未接続（スマホ版ではありません）':'● 閲覧専用 · PC処理は未接続';
  $('pcConnectionHelp').hidden=S.backend||!isLocalPC;
  if(!S.backend&&isLocalPC)status('PC未接続',true);
  window.YohakuAI?.connectionChanged();
}
async function connectPC(refreshPage=true){
  if(!isLocalPC){showConnection();return false;}
  if(connectingPC)return connectingPC;
  connectingPC=(async()=>{try{
    let cfg;try{
    const response=await fetch('/api/config',{cache:'no-store',signal:AbortSignal.timeout(6000)});
    if(!response.ok)throw new Error('PCサーバー未接続');cfg=await response.json();
    if(cfg.app!=='yohaku'||!cfg.token)throw new Error('余白サーバーではありません');
    }catch(e){S.backend=false;showConnection();return false;}
    S.backend=true;S.config=cfg;S.token=cfg.token;if(!prefs.narrator)prefs.narrator=cfg.settings.narrator;
    showConnection();await refreshBooks();
    if(refreshPage&&localBook()&&!S.recording&&!S.playing&&!window.YohakuAI?.hasUnsaved())await showPage(S.page,false);
    return S.backend;
  }finally{connectingPC=null;}})();
  return connectingPC;
}
function savePrefs(){localStorage.setItem('yohaku-prefs',JSON.stringify(prefs));}
async function openDB(){
  S.db=await new Promise((resolve,reject)=>{const r=indexedDB.open('yohaku-reader',1);r.onupgradeneeded=()=>{const d=r.result;d.createObjectStore('books',{keyPath:'id'});const o=d.createObjectStore('ops',{keyPath:'id'});o.createIndex('bookId','bookId');d.createObjectStore('assets',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
function db(store,mode,fn){return new Promise((resolve,reject)=>{const t=S.db.transaction(store,mode);const r=fn(t.objectStore(store));t.oncomplete=()=>resolve(r?.result);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('端末への保存が中断されました'));});}
const rawGet=(store,id)=>db(store,'readonly',s=>s.get(id));
async function assetKey(bookId,page){const b=await rawGet('books',bookId);return b?.drivePageFiles?.[page]?`${bookId}:drive:${b.drivePageFiles[page]}`:`${bookId}:${page}`;}
const get=async(store,id)=>{if(store==='assets'&&/^[a-f0-9]{32}:\d+$/.test(id)){const [b,p]=id.split(':');id=await assetKey(b,Number(p));}return rawGet(store,id);};
const put=(store,value)=>db(store,'readwrite',s=>s.put(value));
const all=store=>db(store,'readonly',s=>s.getAll());
const bookOps=bookId=>db('ops','readonly',s=>s.index('bookId').getAll(bookId));
async function assetStats(bookId,pageCount=null){
  const totals={images:0,texts:0,audio:0,unreviewed:0},book=await get('books',bookId);
  for(let p=0;p<(pageCount??book?.pages??0);p++){const a=await get('assets',`${bookId}:${p}`);if(!a)continue;totals.images+=!!a.image;totals.texts+=!!a.ocr;totals.audio+=!!(a.audio||a.silent);totals.unreviewed+=a.ocr?.reviewState!=='confirmed';}
  return totals;
}
async function storeOps(ops){if(!ops.length)return;await db('ops','readwrite',s=>{for(const o of ops)s.put(o);});}
async function api(path,data){
  let r;try{r=await fetch(path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Yohaku-Token':S.token},body:data===undefined?undefined:JSON.stringify(data)});}catch(e){S.backend=false;showConnection();throw new Error('PC側の余白との接続が切れました。左側の「PCへ再接続」を押してください。保存済みデータは残っています。');}
  if(r.status===403&&isLocalPC){S.backend=false;showConnection();throw new Error('PCサーバーの接続情報が変わりました。「PCへ再接続」後、操作をやり直してください。');}
  const result=await r.json();if(!r.ok)throw new Error(result.error||`処理に失敗しました (${r.status})`);return result;
}
async function waitJob(info,show=true){
  if(!info.job)return info;
  for(;;){const j=await api('/api/jobs/'+info.job);if(show)task(j.message,j.progress);if(j.state==='error'||j.state==='cancelled'){if(show)taskDone();throw new Error(j.error||j.message);}if(j.state==='done'){if(show)taskDone();return j.result;}await new Promise(r=>setTimeout(r,650));}
}
function toData(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});}
async function fetchData(url){const r=await fetch(url);if(!r.ok)throw new Error('ファイルを取得できませんでした');return toData(await r.blob());}
async function patchAsset(bookId,page,patch){const id=await assetKey(bookId,page);await db('assets','readwrite',s=>{const r=s.get(id);r.onsuccess=()=>s.put({...r.result,...patch,id,bookId,page});});}
async function download(name,value,type='application/json'){
  const blob=value instanceof Blob?value:new Blob([typeof value==='string'?value:JSON.stringify(value)],{type});
  if(S.backend){const response=await fetch('/api/export',{method:'POST',headers:{'X-Yohaku-Token':S.token,'X-Export-Name':encodeURIComponent(name)},body:blob});const result=await response.json();if(!response.ok)throw new Error(result.error);toast('アプリの exports フォルダに保存しました：'+result.name);return result;}
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name.replace(/[<>:"/\\|?*]/g,'_');a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function refreshBooks(){
  if(S.backend){try{const books=await api('/api/books');S.serverBooks=new Set(books.map(b=>b.id));for(const b of books){const old=await get('books',b.id);await put('books',{...old,...b});}}catch(e){status('PC接続待ち',true);}}
  S.books=(await all('books')).sort((a,b)=>b.created-a.created);renderBooks();
}
function renderBooks(){
  $('bookCount').textContent=`${S.books.length} BOOKS`;$('bookList').replaceChildren();
  for(const b of S.books){const card=button('',()=>openBook(b.id),'bookCard'+(b.id===S.book?.id?' active':''));const img=document.createElement('img');img.className='coverMini';img.alt='';
    if(S.serverBooks.has(b.id))img.src=`/api/books/${b.id}/image/0`;else get('assets',`${b.id}:0`).then(a=>{if(a?.image)img.src=a.image;});
    const info=document.createElement('div'),title=document.createElement('strong'),sub=document.createElement('small');title.textContent=b.title;sub.textContent=`${b.pages} ページ${b.portable?' · 持ち出し保存':''}`;info.append(title,sub);card.append(img,info);$('bookList').append(card);}
}
async function importPDF(file){
  if(!file)return;if(!S.backend&&isLocalPC)await connectPC(false);if(!S.backend)throw new Error(isLocalPC?'PDF追加にはPC側の余白の起動が必要です。「余白を起動.vbs」を開いてから、もう一度追加してください。':'PDFの準備はPC側の余白で行います。');
  if(file.size>512*1024*1024)throw new Error('PDFは512MB以内にしてください');task('PDFを取り込み中');
  try{const r=await fetch('/api/import',{method:'POST',headers:{'X-Yohaku-Token':S.token,'X-Book-Title':encodeURIComponent(file.name.replace(/\.pdf$/i,''))},body:file});const b=await r.json();if(!r.ok)throw new Error(b.error);await refreshBooks();await openBook(b.id);toast('PDFのコピーを保存しました。原本は変更していません。');window.YohakuAI?.openPrepare();}finally{taskDone();}
}
async function openBook(id){
  if(S.recording)throw new Error('録音を停止してから本を切り替えてください');
  if(window.YohakuAI&&!window.YohakuAI.allowPageChange())return;
  stopPlayback();const b=safeBook(await get('books',id));S.book=b;S.ops=mergeOps(await bookOps(id));
  await syncPC().catch(()=>status('端末保存済み · PC接続待ち',true));await cloudSync().catch(()=>{});S.page=Math.min(b.pages-1,latestPosition(S.ops));localStorage.setItem('yohaku-last-book',id);
  $('welcome').hidden=true;$('readingView').hidden=false;$('readingControls').hidden=false;$('bookTitle').textContent=b.title;$('bookTitle').title=b.title;$('bookSubtitle').textContent='PDFの原本を残し、気づきを別に保存';
  renderBooks();if(innerWidth<900)document.body.classList.add('library-closed');await showPage(S.page,false);syncPC().catch(report);cloudSync().catch(()=>{});
}
async function showPage(page,save=true){
  requireBook();if(S.recording)throw new Error('録音を停止してからページを移動してください');page=Math.max(0,Math.min(S.book.pages-1,Number(page)||0));
  if(window.YohakuAI&&!window.YohakuAI.allowPageChange())return false;
  const epoch=++pageEpoch,bookId=S.book.id;S.page=page;S.selection='';$('contextMenu').hidden=true;
  $('pageNumber').value=page+1;$('pageTotal').textContent='/ '+S.book.pages;$('pageNumber').max=S.book.pages;$('readingPercent').textContent=Math.round((page+1)/S.book.pages*100)+'%';$('notePageLabel').textContent=`P. ${page+1}`;
  $('prevPage').disabled=page===0;$('nextPage').disabled=page===S.book.pages-1;
  $('noteInput').value=localStorage.getItem(`yohaku-draft:${bookId}:${page}`)||'';
  $('pageScroll').scrollTop=0;renderAnnotations();renderNotes();
  const asset=await get('assets',`${bookId}:${page}`);
  if(epoch!==pageEpoch)return;
  $('pageImage').src=localBook()?`/api/books/${bookId}/image/${page}`:asset?.image||'';
  if(!$('pageImage').getAttribute('src'))toast('このページは持ち出し保存されていません。PCで準備してから取得してください。');
  let text=asset?.ocr||{text:'',boxes:[],source:'未OCR'};
  if(localBook()){try{text=await api(`/api/books/${bookId}/text/${page}`);}catch(e){report(e);}}
  if(epoch!==pageEpoch)return;if(!isLocalPC)text=window.YohakuMobile?.textForPage(text)||text;S.ocr=text;$('ocrText').value=text.text||'';$('ocrSource').textContent=text.source||'OCR';renderTextLayer();window.YohakuAI?.pageLoaded(text);window.YohakuMobile?.refresh();
  if(save)await addOp('position',{},false,page,bookId);
  return true;
}
function renderTextLayer(){
  const layer=$('textLayer');layer.replaceChildren();
  for(const box of S.ocr?.boxes||[]){const span=document.createElement('span');span.textContent=box.text;Object.assign(span.style,{left:box.x*100+'%',top:box.y*100+'%',width:box.w*100+'%',height:box.h*100+'%',fontSize:Math.max(6,box.h*$('paper').clientHeight)+'px'});span.title=box.text;layer.append(span);}
}
async function addOp(kind,data={},render=true,page=S.page,bookId=S.book?.id){
  if(!bookId)throw new Error('先に本を開いてください');
  const op={id:crypto.randomUUID(),bookId,page,kind,deviceId,time:Date.now(),...data};
  YohakuCore.validateOp(op);
  await put('ops',op);
  if(S.book?.id===bookId){S.ops=mergeOps(S.ops,[op]);if(render){renderAnnotations();renderNotes();}}
  status(S.backend?'端末保存済み · PC保存待ち':'端末保存済み');syncPC().catch(e=>status('端末保存済み · PC接続待ち',true));return op;
}
async function syncPC(){
  if(S.syncing||!localBook())return;S.syncing=true;const bookId=S.book.id;
  try{const ops=await bookOps(bookId);let remote=[],chunk=[],bytes=0;
    for(const op of ops){const size=JSON.stringify(op).length;if(bytes+size>16000000&&chunk.length){remote=await api(`/api/books/${bookId}/ops`,{ops:chunk});chunk=[];bytes=0;}chunk.push(op);bytes+=size;}
    remote=await api(`/api/books/${bookId}/ops`,{ops:chunk});
    const merged=mergeOps(await bookOps(bookId),remote);await storeOps(merged);
    if(S.book?.id===bookId){const changed=merged.length!==S.ops.length;S.ops=merged;if(changed){renderNotes();renderAnnotations();}status('PCに保存済み');}
  }finally{S.syncing=false;}
}
const drive=new YohakuDrive(message=>{$('driveStatus').textContent=message;window.YohakuMobile?.driveStatus(message);});
async function cloudSync(){
  if(!drive.connected||S.cloudSyncing||!S.book||!navigator.onLine)return;S.cloudSyncing=true;const id=S.book.id;
  try{const local=await bookOps(id),remote=await drive.sync(id,local);const merged=mergeOps(await bookOps(id),remote);await storeOps(merged);
    localStorage.setItem('yohaku-synced:'+id,JSON.stringify(local.map(o=>o.id)));
    if(S.book?.id===id){S.ops=merged;renderNotes();renderAnnotations();}await syncPC();window.YohakuMobile?.refresh();
  }catch(e){$('driveStatus').textContent=e.message;throw e;}finally{S.cloudSyncing=false;}
}
function renderAnnotations(){
  const layer=$('annotationLayer');layer.replaceChildren();
  for(const o of activeOps(S.ops).filter(o=>o.page===S.page)){
    let el;if(o.kind==='ink'){el=document.createElementNS('http://www.w3.org/2000/svg','polyline');el.setAttribute('points',o.points.map(p=>`${p[0]*1000},${p[1]*1000}`).join(' '));el.setAttribute('fill','none');el.setAttribute('stroke',o.color||'#b99150');el.setAttribute('stroke-width','3');el.setAttribute('stroke-linecap','round');el.setAttribute('stroke-linejoin','round');}
    if(o.kind==='highlight'&&o.rect){el=document.createElementNS('http://www.w3.org/2000/svg','rect');const [x,y,w,h]=o.rect;el.setAttribute('x',x*1000);el.setAttribute('y',y*1000);el.setAttribute('width',w*1000);el.setAttribute('height',h*1000);el.setAttribute('fill',o.color||'#e5ca4f');el.setAttribute('opacity','.36');}
    if(el){el.dataset.opId=o.id;layer.append(el);}
  }
  $('questionButton').classList.toggle('active',activeOps(S.ops).some(o=>o.page===S.page&&o.kind==='question'));
}
function renderNotes(){
  const list=$('notesList');list.replaceChildren();const filter=$('noteFilter').value;
  const notes=activeOps(S.ops).filter(o=>filter==='page'?o.page===S.page:filter==='all'?true:o.kind===filter).sort((a,b)=>a.page-b.page||b.time-a.time);
  if(!notes.length){const p=document.createElement('p');p.className='emptyHint';p.textContent='まだ記録はありません。\n気づいたことから、ひとつずつ。';list.append(p);return;}
  for(const o of notes){const card=document.createElement('article');card.className='noteCard';const meta=document.createElement('div');meta.className='noteMeta';
    const label={note:'メモ',question:'？ あとで確認',ink:'手書き',highlight:'マーカー'}[o.kind];meta.append(button(`P. ${o.page+1} · ${label}`,()=>showPage(o.page)),button('削除',()=>addOp('delete',{target:o.id},true,o.page)));
    const p=document.createElement('p');p.textContent=o.text||(o.kind==='ink'?'ページに手書きを保存しました。':o.kind==='highlight'?'ページの範囲をマークしました。':'章末など、あとで確認するページ。');card.append(meta,p);
    if(o.audio){const a=document.createElement('audio');a.controls=true;a.preload='none';a.src=o.audio;card.append(a);card.append(button('PC内で文字起こし（要確認）',()=>transcribeNote(o),'subtle transcribe'));}
    window.YohakuMobile?.noteActions(card,o);list.append(card);
  }
}
function selectTool(tool){S.tool=tool;document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));$('paper').classList.toggle('drawing',tool!=='read');$('paper').classList.toggle('eraser',tool==='erase');}
let stroke=null;
function pointerPos(e){const r=$('annotationLayer').getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];}
$('annotationLayer').addEventListener('pointerdown',e=>{
  if(!S.book||S.tool==='read')return;e.preventDefault();
  if(S.tool==='erase'){const id=e.target.dataset.opId;if(id)addOp('delete',{target:id}).catch(report);return;}
  const points=[pointerPos(e)];stroke={tool:S.tool,points,color:$('inkColor').value,bookId:S.book.id,page:S.page};$('annotationLayer').setPointerCapture(e.pointerId);
});
$('annotationLayer').addEventListener('pointermove',e=>{if(!stroke)return;stroke.points.push(pointerPos(e));renderAnnotations();const layer=$('annotationLayer');let preview=document.createElementNS('http://www.w3.org/2000/svg',stroke.tool==='ink'?'polyline':'rect');
  if(stroke.tool==='ink'){preview.setAttribute('points',stroke.points.map(p=>p.map(v=>v*1000).join(',')).join(' '));preview.setAttribute('fill','none');preview.setAttribute('stroke',stroke.color);preview.setAttribute('stroke-width','3');}
  else{const a=stroke.points[0],b=stroke.points.at(-1);for(const [key,val] of Object.entries({x:Math.min(a[0],b[0])*1000,y:Math.min(a[1],b[1])*1000,width:Math.abs(a[0]-b[0])*1000,height:Math.abs(a[1]-b[1])*1000,fill:stroke.color,opacity:.35}))preview.setAttribute(key,val);}
  layer.append(preview);
});
async function endStroke(){if(!stroke)return;const st=stroke;stroke=null;const a=st.points[0],b=st.points.at(-1);
  if(st.tool==='ink'&&st.points.length>1)await addOp('ink',{points:st.points,color:st.color},true,st.page,st.bookId);
  else if(st.tool==='highlight'&&Math.abs(a[0]-b[0])>.005&&Math.abs(a[1]-b[1])>.003)await addOp('highlight',{rect:[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1])],color:st.color},true,st.page,st.bookId);
  renderAnnotations();
}
$('annotationLayer').addEventListener('pointerup',()=>endStroke().catch(report));$('annotationLayer').addEventListener('pointercancel',()=>{stroke=null;renderAnnotations();});
async function runOCR(){requirePC();if(window.YohakuAI?.hasUnsaved())throw new Error('編集中の文章を先に保存してください。');const bookId=S.book.id,page=S.page;
  await waitJob(await api(`/api/books/${bookId}/ocr`,{page,mode:$('ocrMode').value,force:true}));
  const result=await api(`/api/books/${bookId}/text/${page}`);await patchAsset(bookId,page,{ocr:result});
  if(S.book?.id===bookId&&S.page===page&&!window.YohakuAI?.hasUnsaved()){S.ocr=result;$('ocrText').value=result.text;$('ocrSource').textContent=result.source;window.YohakuAI?.pageLoaded(result);renderTextLayer();}
  toast('OCRが完了しました。手修正文や入力中の文章は上書きしていません。元OCRから結果を確認できます。');}
function selectedText(){
  const t=$('ocrText');return t.selectionEnd>t.selectionStart?t.value.slice(t.selectionStart,t.selectionEnd):window.getSelection()?.toString().trim()||S.selection;
}
async function askAI(service){
  requireBook();const text=(S.selection||selectedText()).trim();if(!text)throw new Error('PDF上、またはOCR欄で質問したい言葉を選択してください');
  const styles={simple:'初めて学ぶ人にも分かるよう、やさしく説明してください。',example:'意味を短く説明し、身近な具体例を3つ挙げてください。',context:'この言葉・文章がこの文脈で何を意味するのか説明してください。文脈が足りなければ推測と事実を区別してください。'};
  let prompt=`読書中の質問です。\n\n「${text.slice(0,4000)}」\n\n${styles[$('questionStyle').value]}`;
  if($('includeContext').checked){const full=S.ocr?.text||'',idx=full.indexOf(text);if(idx>=0)prompt+='\n\n参考の前後の文章：\n'+full.slice(Math.max(0,idx-180),idx+text.length+180);}
  const copying=navigator.clipboard?.writeText(prompt);
  window.open(service==='gemini'?'https://gemini.google.com/':'https://chatgpt.com/','_blank','noopener,noreferrer');
  try{if(!copying)throw new Error('clipboard unavailable');await copying;toast('質問文をコピーしました。開いたチャット欄に貼り付けて送信してください。');}
  catch(e){$('noteInput').value=prompt;toast('コピーできませんでした。メモ欄に質問文を表示しました。選択してコピーしてください。');}
  $('contextMenu').hidden=true;
}
function captureSelection(e){const text=selectedText().trim();if(!text)return;S.selection=text;if(e.type==='contextmenu'){e.preventDefault();$('contextMenu').style.left=Math.min(e.clientX,innerWidth-235)+'px';$('contextMenu').style.top=Math.min(e.clientY,innerHeight-150)+'px';$('contextMenu').hidden=false;}}
$('ocrText').addEventListener('select',()=>{const t=$('ocrText');if(t.selectionEnd>t.selectionStart)S.selection=t.value.slice(t.selectionStart,t.selectionEnd);});
$('ocrText').addEventListener('contextmenu',captureSelection);$('textLayer').addEventListener('contextmenu',captureSelection);$('textLayer').addEventListener('mouseup',captureSelection);
document.addEventListener('click',e=>{if(!e.target.closest('.contextMenu'))$('contextMenu').hidden=true;});
async function searchBook(){
  requireBook();const term=$('searchInput').value.trim(),id=S.book.id,results=$('searchResults');results.replaceChildren();if(!term)return;
  let pages;if(localBook())pages=await api(`/api/books/${id}/texts`);else {pages=[];const count=S.book.pages;for(let p=0;p<count;p++){const a=await get('assets',`${id}:${p}`);if(a?.ocr)pages.push({page:p,text:a.ocr.text});}}
  if(S.book?.id!==id||$('searchInput').value.trim()!==term)return;
  for(const p of pages){const i=p.text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());if(i<0)continue;const b=button('',()=>showPage(p.page),'searchResult');const meta=document.createElement('small');meta.textContent=`PDF ${p.page+1} ページ`;const span=document.createElement('span');span.textContent=p.text.slice(Math.max(0,i-40),i+term.length+85);b.append(meta,span);results.append(b);}
  if(!results.childNodes.length)results.textContent='見つかりませんでした。未OCRのページは検索対象外です。';
}
function speechOptions(){return {narrator:prefs.narrator||S.config.settings?.narrator||'Japanese Female 1',voiceSpeed:Number(prefs.voiceSpeed||100),mode:$('ocrMode').value,...window.YohakuAI?.options()};}
function speechKey(bookId,page){return [bookId,page,JSON.stringify(speechOptions()),prefs.dictionaryVersion].join(':');}
async function audioFor(bookId,page){
  const key=speechKey(bookId,page);if(!S.backend&&S.audioCache.has(key))return S.audioCache.get(key);
  if(S.prefetch.has(key))return S.prefetch.get(key);
  const promise=(async()=>{
    let result;if(S.backend&&S.serverBooks.has(bookId)){result=await waitJob(await api(`/api/books/${bookId}/speech`,{page,...speechOptions()}),false);}
    else{const asset=await get('assets',`${bookId}:${page}`);if(!asset?.audio&&!asset?.silent)throw new Error('このページの音声は未準備です。PCで音声付きの持ち出し準備をしてください。');if(speechOptions().listenMode==='reviewed'&&asset.ocr?.reviewState!=='confirmed'&&!asset.ocr?.corrected)throw new Error('未確認の文章です。「未確認でもすぐ聴く」を選ぶと再生できます。');result={url:asset.audio,silent:asset.silent,page,reviewState:asset.ocr?.reviewState||'ocr'};}
    S.audioCache.set(key,result);while(S.audioCache.size>4)S.audioCache.delete(S.audioCache.keys().next().value);return result;
  })();S.prefetch.set(key,promise);try{return await promise;}finally{S.prefetch.delete(key);}
}
function stopPlayback(){S.playing=false;S.paused=false;S.playEpoch++;$('narration').pause();$('playButton').textContent='▶';$('audioStatus').textContent=isLocalPC?'VOICEPEAKで聴く':'保存済みの音声を聴く';$('audioDetail').textContent=isLocalPC?'ページごとに音声を準備します':'生成済み音声のみ。変更はPCで再生成します。';}
async function playPage(page,epoch=S.playEpoch){
  const id=S.book.id;S.audioPage=page;$('audioStatus').textContent=`${page+1}ページの音声を準備中…`;$('audioDetail').textContent=isLocalPC?'初回は生成に時間がかかります':'端末に保存した音声を読み込んでいます';
  const data=await audioFor(id,page);if(epoch!==S.playEpoch||id!==S.book?.id||!S.playing)return;
  if($('followAudio').checked&&S.page!==page&&await showPage(page)===false){stopPlayback();return;}
  $('audioStatus').textContent=`${page+1}ページを朗読中`;$('audioDetail').textContent=data.reviewState==='confirmed'?'確認済みの文章':'未確認の文章です。気になる箇所は後で確認できます';
  if(data.silent){await afterAudio(epoch);return;}
  const audio=$('narration');audio.src=data.url;audio.playbackRate=Number($('playbackRate').value);await audio.play();$('playButton').textContent='Ⅱ';
  if(page+1<S.book.pages)audioFor(id,page+1).catch(e=>{$('audioDetail').textContent='次ページの準備が必要です。再生時に再試行します。';});
}
async function afterAudio(epoch=S.playEpoch){
  if(!S.playing||epoch!==S.playEpoch)return;const next=S.audioPage+1;
  if(next>=S.book.pages){stopPlayback();$('audioStatus').textContent='最後のページまで読み終えました';return;}
  await new Promise(r=>setTimeout(r,Number(prefs.pageDelay??1)*1000));if(epoch===S.playEpoch&&S.playing)await playPage(next,epoch);
}
$('narration').addEventListener('ended',()=>afterAudio().catch(e=>{stopPlayback();report(e);}));
$('narration').addEventListener('error',()=>{if(S.playing){stopPlayback();toast('音声を再生できませんでした。PCで再生成してください。');}});
let recorder,recordStream,recordChunks=[],recordTimer,recordTarget;
async function toggleRecord(){
  requireBook();if(S.recording){recorder.stop();return;}
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('録音にはHTTPS、またはPCのlocalhostで開いてください');
  if(typeof MediaRecorder==='undefined')throw new Error('このブラウザは録音に対応していません');
  recordStream=await navigator.mediaDevices.getUserMedia({audio:true});
  recordTarget={bookId:S.book.id,page:S.page,resume:S.playing,epoch:S.playEpoch};$('narration').pause();S.playing=false;
  const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(x=>MediaRecorder.isTypeSupported(x));
  recorder=new MediaRecorder(recordStream,mime?{mimeType:mime}:undefined);recordChunks=[];S.recording=true;$('recordButton').textContent='■ 録音を停止';$('recordButton').classList.add('recording');$('recordStatus').textContent='録音中。最大3分で自動停止します。朗読は一時停止しています。';
  recorder.ondataavailable=e=>{if(e.data.size)recordChunks.push(e.data);};
  recorder.onstop=async()=>{
    clearTimeout(recordTimer);recordStream.getTracks().forEach(t=>t.stop());S.recording=false;$('recordButton').textContent='● 音声メモ';$('recordButton').classList.remove('recording');
    try{const blob=new Blob(recordChunks,{type:recorder.mimeType});if(blob.size>10_000_000)throw new Error('録音が10MBを超えました。ダウンロードして保管してください');
      const audio=await toData(blob);const op=await addOp('note',{text:'音声メモ（未文字起こし）',audio},true,recordTarget.page,recordTarget.bookId);$('recordStatus').textContent='元音声を保存しました。PC内で文字起こしできます。';
      if(S.config.transcriptionReady&&localBook())transcribeNote(op).catch(report);
    }catch(e){await download('音声メモ-救済.webm',new Blob(recordChunks,{type:recorder.mimeType}));report(e);}
    finally{if(recordTarget.resume&&recordTarget.bookId===S.book?.id&&recordTarget.epoch===S.playEpoch){S.playing=true;$('narration').play().catch(e=>{stopPlayback();report(e);});}}
  };
  recorder.start();recordTimer=setTimeout(()=>{if(S.recording)recorder.stop();},180000);
}
async function transcribeNote(op){
  if(!S.backend)throw new Error('文字起こしは同期後、PC版で実行できます。元音声は保存されています。');
  const result=await waitJob(await api('/api/transcribe',{audio:op.audio}));await addOp('note',{text:result.text+'\n（自動文字起こし・要確認）',sourceNote:op.id},true,op.page,op.bookId);toast('文字起こしを別メモとして保存しました。元音声も残しています。');
}
async function loadPageAsset(book,page){
  let asset=await get('assets',`${book.id}:${page}`)||{};
  if(S.backend&&S.serverBooks.has(book.id)){
    const query=new URLSearchParams({narrator:speechOptions().narrator,voiceSpeed:speechOptions().voiceSpeed,audioMode:$('exportAudioMode').value||'saved'});
    const image=await fetchData(`/api/books/${book.id}/image/${page}`),ocr=await api(`/api/books/${book.id}/text/${page}`),info=await api(`/api/books/${book.id}/audio-info/${page}?${query}`);
    const audio=info.url?await fetchData(info.url):null;asset={image,ocr,audio,silent:info.silent||false,audioInfo:info};
    await patchAsset(book.id,page,asset);
  }
  return {image:asset.image,ocr:asset.ocr,audio:asset.audio,silent:asset.silent||false,audioInfo:asset.audioInfo};
}
async function exportPack(notesOnly=false){
  const book=requireBook();if(S.busy)throw new Error('別の準備が終わるまでお待ちください');
  if(!notesOnly&&localBook()){
    const audioMode=$('exportAudioMode').value;
    if(window.YohakuAI&&!await window.YohakuAI.confirmPortable(audioMode))return;
    S.busy=true;
    try{
      showExportResult(null);$('exportResult').hidden=false;$('exportLocation').textContent='PCへ書き出しています。完了するとここに保存先が表示されます。';
      const info=await api(`/api/books/${book.id}/export-pack`,{...speechOptions(),audioMode,ops:await bookOps(book.id)});
      const result=await waitJob(info);if(S.book?.id===book.id)showExportResult(result);
      toast(`PCへ${result.files.length}ファイルを書き出しました。「保存先フォルダを開く」で確認できます。`);
    }catch(e){$('exportLocation').textContent='書き出し未完了：'+e.message;throw e;}
    finally{S.busy=false;taskDone();}return;
  }
  if(!notesOnly&&window.YohakuAI&&!await window.YohakuAI.confirmPortable())return;S.busy=true;
  try{const pack={format:'yohaku',schema:1,book,ops:await bookOps(book.id),assets:[]};
    let size=JSON.stringify(pack.ops).length;
    if(!notesOnly)for(let page=0;page<book.pages;page++){task(`持ち出しファイルを作成中 ${page+1} / ${book.pages}`,page/book.pages*100);const asset={page,...await loadPageAsset(book,page)};size+=JSON.stringify(asset).length;if(size>450*1024*1024)throw new Error('書き出し未完了：PC版で分割書き出しを行ってください。この操作ではGoogle Driveにも保存していません。');pack.assets.push(asset);}
    await download(book.title+(notesOnly?'-メモ':'-持ち出し')+'.yohaku',pack);toast((S.backend?'exports フォルダに':'')+(notesOnly?'メモのバックアップを書き出しました。':'持ち出しファイルを書き出しました。未生成の音声は含まれません。'));
  }finally{S.busy=false;taskDone();}
}
let lastExport=null;
function showExportResult(r){
  lastExport=r?.exportId?r:null;$('exportResult').hidden=!lastExport;$('openExportFolder').hidden=!lastExport;
  if(!lastExport)return;
  $('exportLocation').textContent=`保存先：${r.folder}\n${r.files.length}ファイル・全${r.pages}ページ・音声${r.audio}ページ\n未生成の音声：${r.missingAudioPages.length}ページ／以前の設定・文章の音声：${r.outdatedAudioPages.length}ページ\n分割ファイルはすべて持ち出してください。Google Driveへは送信していません。`;
}
async function refreshExportResult(){const book=S.book;showExportResult(null);if(!localBook(book))return;const r=await api(`/api/books/${book.id}/last-export`);if(S.book?.id===book.id)showExportResult(r);}
bind('openExportFolder',async()=>{if(lastExport)await api('/api/open-export-folder',{exportId:lastExport.exportId});});
function validateAsset(asset,pages){
  if(!Number.isInteger(asset.page)||asset.page<0||asset.page>=pages)throw new Error('ページが不正です');
  if(asset.image&&!/^data:image\/(jpeg|png|webp);base64,/.test(asset.image))throw new Error('画像形式が不正です');
  if(asset.audio&&!/^data:audio\/[\w.+;-]+;base64,/.test(asset.audio))throw new Error('音声形式が不正です');
  if(asset.ocr&&(typeof asset.ocr.text!=='string'||!Array.isArray(asset.ocr.boxes)))throw new Error('OCR形式が不正です');
}
async function importPack(file){
  if(!file)return;if(file.size>512*1024*1024)throw new Error('持ち出しファイルは512MB以内にしてください。大きい本はDriveのページ別保存を使えます。');
  task('持ち出しデータを読み込み中');
  try{const pack=JSON.parse(await file.text());if(pack.format!=='yohaku'||pack.schema!==1||!Array.isArray(pack.ops)||!Array.isArray(pack.assets))throw new Error('余白の持ち出しファイルではありません');
    const book=safeBook(pack.book);for(const a of pack.assets)validateAsset(a,book.pages);
    if(new Set(pack.assets.map(a=>a.page)).size!==pack.assets.length)throw new Error('同じページが重複しています');
    if(pack.ops.some(o=>o.bookId!==book.id))throw new Error('注釈の書籍IDが一致しません');
    const ops=mergeOps(await bookOps(book.id),pack.ops);for(const a of pack.assets)await patchAsset(book.id,a.page,a);
    await storeOps(ops);const storedAssets=await assetStats(book.id,book.pages);const previous=await get('books',book.id);await put('books',{...previous,...book,drivePageFiles:previous?.drivePageFiles,portable:storedAssets.images===book.pages});await refreshBooks();await openBook(book.id);toast('読み込みました。既存のメモは消さずに統合しました。');
  }finally{taskDone();}
}
async function demo(){
  const id='00000000000000000000000000000001',book={id,title:'余白の使い方 — はじめの一冊',pages:3,created:Date.now(),schema:1,portable:true};
  const pages=[['本のそばに、あなたの気づきを。','読む、聴く、書きとめる。','余白は、スクショしたPDFと読書メモのための場所です。','ページの見た目はそのままに、気になったところへ','マーカーを引いたり、手書きで言葉を添えられます。','まずは上の「マーカー」を選んで、線を引いてみましょう。'],['わからない言葉に出会ったら。','選んで、聞いて、理解を深める。','OCRは画像に写った文字を、テキストへ変える技術です。','右の「OCR・質問」から文章を選び、右クリックすると','質問文をコピーしてChatGPTやGeminiを開けます。','AIへ送信する前に、質問内容をご自身で確認できます。'],['思いついたことを、なくさない。','メモは、本とは別に大切に保存。','メモ・手書き・疑問はページ番号と一緒に保存します。','「？」を付けたページだけを、あとで一覧にできます。','このサンプルは説明用です。朗読は実際のPDFをPCへ','追加し、VOICEPEAKで準備してからお試しください。']];
  for(let p=0;p<3;p++){
    const lines=pages[p],boxes=lines.map((text,i)=>({text,x:.11,y:(150+i*64)/1040,w:.8,h:(i<2?28:19)/1040}));
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="760" height="1040"><rect width="760" height="1040" fill="#fffefa"/><text x="84" y="72" font-family="sans-serif" font-size="11" letter-spacing="4" fill="#8a977d">YOHAKU · FIRST READING</text><line x1="84" x2="676" y1="95" y2="95" stroke="#d8dfd0"/>${lines.map((t,i)=>`<text x="84" y="${175+i*64}" font-family="${i<2?'serif':'sans-serif'}" font-size="${i===0?27:i===1?21:18}" fill="#2e493e">${escapeXml(t)}</text>`).join('')}<path d="M84 625h590" stroke="#dfc36e" stroke-width="10" opacity=".45"/><text x="84" y="700" font-family="serif" font-size="20" fill="#87917d">あなたのペースで、読書を。</text><text x="380" y="982" text-anchor="middle" font-size="12" fill="#88917f">${p+1}</text></svg>`;
    const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=760;c.height=1040;c.getContext('2d').drawImage(img,0,0);resolve(c.toDataURL('image/png'));};img.onerror=reject;img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);});
    await patchAsset(id,p,{image,ocr:{text:lines.join('\n'),original:lines.join('\n'),boxes,source:'サンプル本文'}});
  }
  await put('books',book);await refreshBooks();await openBook(id);
}
function setTab(tab){document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));for(const name of ['notes','ocr','search'])$(name+'Panel').hidden=name!==tab;}
bind('libraryToggle',()=>{document.body.classList.toggle('library-closed');if(innerWidth<900&&!document.body.classList.contains('library-closed'))document.body.classList.add('notebook-closed');});
bind('reconnectPC',async()=>toast(await connectPC()?'PCに再接続しました。':'まだ接続できません。「余白を起動.vbs」を開いてください。'));
bind('editPageShortcut',()=>{requireBook();document.body.classList.remove('notebook-closed');setTab('ocr');$('ocrPanel').scrollTop=0;$('ocrText').focus();});
bind('notebookToggle',()=>{document.body.classList.toggle('notebook-closed');if(innerWidth<900&&!document.body.classList.contains('notebook-closed'))document.body.classList.add('library-closed');});
bind('closeNotebook',()=>document.body.classList.add('notebook-closed'));
for(const id of ['importButton','welcomeImport'])bind(id,()=>{$('pdfInput').click();});
$('pdfInput').onchange=e=>{importPDF(e.target.files[0]).catch(report).finally(()=>e.target.value='');};
bind('restoreButton',()=>$('packInput').click());$('packInput').onchange=async e=>{const files=[...e.target.files];try{for(const file of files)await importPack(file);if(files.length>1)toast(`${files.length}個の分割ファイルを読み込みました。`);}catch(error){report(error);}finally{e.target.value='';}};
bind('demoButton',demo);
bind('prevPage',()=>showPage(S.page-1));bind('nextPage',()=>showPage(S.page+1));$('pageNumber').onchange=()=>showPage(Number($('pageNumber').value)-1).catch(report);
bind('questionButton',()=>addOp('question',{text:'あとで確認したいページ'}));
bind('undoButton',async()=>{requireBook();const last=activeOps(S.ops).filter(o=>o.page===S.page&&o.deviceId===deviceId).at(-1);if(last)await addOp('delete',{target:last.id});else toast('取り消す記録がありません。');});
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>selectTool(b.dataset.tool));
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
document.querySelectorAll('[data-ai]').forEach(b=>b.onclick=()=>askAI(b.dataset.ai).catch(report));
bind('selectionHighlight',()=>addOp('note',{text:S.selection}));
$('noteInput').oninput=()=>{if(S.book)localStorage.setItem(`yohaku-draft:${S.book.id}:${S.page}`,$('noteInput').value);};
bind('saveNote',async()=>{requireBook();const text=$('noteInput').value.trim();if(!text)throw new Error('メモを入力してください');const id=S.book.id,page=S.page;await addOp('note',{text});localStorage.removeItem(`yohaku-draft:${id}:${page}`);if(S.book?.id===id&&S.page===page)$('noteInput').value='';toast('メモを保存しました。');});
$('noteFilter').onchange=renderNotes;bind('recordButton',toggleRecord);
bind('ocrButton',runOCR);
bind('saveOcr',async()=>{if(!isLocalPC)return window.YohakuMobile.saveCorrection();requirePC();const id=S.book.id,page=S.page,text=$('ocrText').value;const result=await api(`/api/books/${id}/edit`,{page,text,revision:S.ocr?.revision});S.audioCache.clear();if(S.book?.id===id&&S.page===page){S.ocr=result;if($('ocrText').value===text)window.YohakuAI?.pageLoaded(result);$('ocrSource').textContent=result.source;renderTextLayer();await patchAsset(id,page,{ocr:result});}toast('保存ボタンを押した時点の文章を確認済みとして保存しました。続けて入力した分は再度保存してください。');});
bind('ocrOriginal',()=>{requireBook();if(S.ocr?.original!==undefined)alert(S.ocr.original||'元のOCRは空です。');});
$('searchInput').oninput=()=>{clearTimeout(renderTimer);renderTimer=setTimeout(()=>searchBook().catch(report),250);};
let zoomMode=prefs.pageZoom||'page',zoomFrame=0,actualZoom=100;
if(!['page','fit','height'].includes(zoomMode)&&!(Number(zoomMode)>=10&&Number(zoomMode)<=400))zoomMode='page';
function applyZoom(reset=false){
  const image=$('pageImage'),viewport=$('pageScroll'),paper=$('paper');
  if(!image.complete||!image.naturalWidth||!viewport.clientHeight)return;
  const css=getComputedStyle(viewport),horizontal=parseFloat(css.paddingLeft)+parseFloat(css.paddingRight),vertical=parseFloat(css.paddingTop)+parseFloat(css.paddingBottom);
  // Reserve a pixel for rounding, including fractional device/browser scaling.
  const size=YohakuCore.pageSize(image.naturalWidth,image.naturalHeight,viewport.clientWidth-horizontal-1,viewport.clientHeight-vertical-1,zoomMode);
  if(!size)return;
  actualZoom=size.percent;paper.style.width=size.width+'px';paper.style.maxWidth='none';
  const preset=[...$('zoom').options].some(o=>o.value===String(zoomMode));
  $('zoom').value=preset?String(zoomMode):'custom';
  $('zoom').querySelector('[value="custom"]').hidden=preset;
  $('zoomPercent').value=Math.round(actualZoom*10)/10;
  $('zoomOut').disabled=actualZoom<=10;$('zoomIn').disabled=actualZoom>=400;
  if(reset||zoomMode==='page'){viewport.scrollTop=0;viewport.scrollLeft=0;}
  if(zoomMode==='height')viewport.scrollTop=0;
  renderTextLayer();
}
function scheduleZoom(){cancelAnimationFrame(zoomFrame);zoomFrame=requestAnimationFrame(()=>applyZoom());}
function setZoom(mode){zoomMode=['page','fit','height'].includes(mode)?mode:String(Math.max(10,Math.min(400,Number(mode)||100)));prefs.pageZoom=zoomMode;savePrefs();applyZoom(true);}
$('zoom').onchange=()=>{if($('zoom').value!=='custom')setZoom($('zoom').value);};
$('zoomPercent').onchange=()=>setZoom($('zoomPercent').value);
$('zoomPercent').onkeydown=e=>{if(e.key==='Enter'){setZoom($('zoomPercent').value);e.preventDefault();}};
bind('zoomOut',()=>setZoom(Math.max(10,Math.round(actualZoom)-10)));
bind('zoomIn',()=>setZoom(Math.min(400,Math.round(actualZoom)+10)));
$('pageImage').onload=()=>applyZoom(true);window.addEventListener('resize',scheduleZoom);
// Sidebar toggles and toolbar wrapping change the actual reading area, not just the window.
const pageResizeObserver=new ResizeObserver(scheduleZoom);pageResizeObserver.observe($('pageScroll'));
bind('playButton',async()=>{requireBook();if(S.recording)throw new Error('録音を停止してから朗読してください');if(S.playing){
  if(!$('narration').paused&&!$('narration').ended){S.playing=false;S.paused=true;$('narration').pause();$('playButton').textContent='▶';$('audioStatus').textContent='一時停止中';}else stopPlayback();return;}
  if(S.paused&&S.page===S.audioPage){S.playing=true;S.paused=false;try{await $('narration').play();$('playButton').textContent='Ⅱ';$('audioStatus').textContent=`${S.audioPage+1}ページを朗読中`;}catch(e){stopPlayback();throw e;}return;}
  S.paused=false;S.playing=true;S.playEpoch++;try{await playPage(S.page);}catch(e){stopPlayback();throw e;}});
bind('repeatButton',async()=>{requireBook();if(S.recording)throw new Error('先に録音を停止してください');stopPlayback();S.playing=true;try{await playPage(S.audioPage);}catch(e){stopPlayback();throw e;}});bind('audioPageButton',()=>showPage(S.audioPage));
$('playbackRate').onchange=()=>{$('narration').playbackRate=Number($('playbackRate').value);prefs.playbackRate=$('playbackRate').value;savePrefs();};
bind('exportMarkdown',()=>download(requireBook().title+'-読書メモ.md',markdown(S.book,S.ops),'text/markdown;charset=utf-8'));
bind('exportPack',()=>exportPack());bind('backupNotes',()=>exportPack(true));
bind('prepareButton',()=>window.YohakuAI.openPrepare());
bind('startPrepare',()=>window.YohakuAI.startPrepare());
bind('settingsButton',()=>{
  $('narrator').value=prefs.narrator||S.config.settings?.narrator||'Japanese Female 1';$('voiceSpeed').value=prefs.voiceSpeed||100;$('pageDelay').value=prefs.pageDelay??1;
  const cfg=S.config.settings||{};$('dictionary').value=(cfg.dictionary||[]).map(x=>x.word+'='+x.reading).join('\n');$('voicepeakPath').value=cfg.voicepeak||'';$('tesseractPath').value=cfg.tesseract||'';$('whisperPath').value=cfg.whisperModel||'';$('googleClientId').value=localStorage.getItem('yohaku-google-client')||globalThis.YohakuDeployment?.googleClientId||'';
  $('engineStatus').textContent=S.backend?`OCR: ${S.config.ocrReady?'検出済み':'未検出'} / VOICEPEAK: ${S.config.voiceReady?'検出済み':'未検出'} / 音声認識: ${S.config.transcriptionReady?'準備済み':'モデル未設定'}`:'スマホ・オフライン版です。OCRと音声生成はPCで行います。';$('settingsDialog').showModal();
  window.YohakuAI?.settingsOpened();
});
bind('saveSettings',async()=>{
  prefs.narrator=$('narrator').value;prefs.voiceSpeed=Math.max(50,Math.min(200,Number($('voiceSpeed').value)||100));prefs.pageDelay=Math.max(0,Math.min(30,Number($('pageDelay').value)||0));prefs.dictionaryVersion=Date.now();
  if(S.backend){const dictionary=$('dictionary').value.split('\n').filter(x=>x.trim()).map(line=>{const i=line.indexOf('=');if(i<1)throw new Error('辞書は「単語=よみがな」の形式で入力してください');return {word:line.slice(0,i).trim(),reading:line.slice(i+1).trim()};});await api('/api/settings',{narrator:prefs.narrator,voiceSpeed:prefs.voiceSpeed,dictionary,voicepeak:$('voicepeakPath').value,tesseract:$('tesseractPath').value,whisperModel:$('whisperPath').value,...window.YohakuAI.options()});S.config=await api('/api/config');}
  savePrefs();S.audioCache.clear();toast('設定を保存しました。声や辞書の変更は次の音声生成から反映します。');
});
bind('connectDrive',async()=>{const id=$('googleClientId').value.trim();localStorage.setItem('yohaku-google-client',id);await drive.connect(id);await cloudSync();});
bind('disconnectDrive',()=>drive.disconnect());bind('syncNow',async()=>{if(!drive.connected)throw new Error('先にGoogleに接続してください');await cloudSync();});
bind('uploadBook',()=>window.YohakuMobile.upload());
bind('cloudLibraryButton',()=>window.YohakuMobile.openDrive(true));
document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)||document.querySelector('dialog[open]')||!S.book)return;if(e.key==='ArrowRight'){e.preventDefault();showPage(S.page+1).catch(report);}if(e.key==='ArrowLeft'){e.preventDefault();showPage(S.page-1).catch(report);}if(e.key==='Escape'){document.body.classList.add('notebook-closed');$('contextMenu').hidden=true;}});
window.addEventListener('online',()=>{syncPC().catch(()=>{});cloudSync().catch(()=>{});});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){syncPC().catch(()=>{});cloudSync().catch(()=>{});}});
window.addEventListener('beforeunload',e=>{if(S.recording||S.busy){e.preventDefault();e.returnValue='';}});
async function init(){
  if(innerWidth<900)document.body.classList.add('library-closed');if(innerWidth<650)document.body.classList.add('notebook-closed');
  await openDB();await connectPC(false);
  window.YohakuAI?.initialize();
  $('playbackRate').value=prefs.playbackRate||'1';await refreshBooks();status(S.backend?'PCに接続済み':isLocalPC?'PC未接続':'端末に保存',!S.backend&&isLocalPC);
  const last=localStorage.getItem('yohaku-last-book');if(last&&S.books.some(b=>b.id===last))await openBook(last);
  if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
  window.YohakuMobile?.ready();
  setInterval(()=>{if(isLocalPC&&!S.backend)connectPC().catch(()=>{});},10000);
  setInterval(()=>syncPC().catch(()=>status('端末保存済み · PC接続待ち',true)),5000);
  setInterval(()=>cloudSync().catch(()=>{}),30000);
}
init().catch(e=>{status('起動エラー',true);report(e);});
