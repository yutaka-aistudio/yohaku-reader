'use strict';
/* The same static shell works at / and at GitHub Pages /repository/. No server or secrets here. */
window.YohakuMobile=(()=>{
  let cancelled=false,transfer=false,wakeLock=null;
  const clientId=()=>localStorage.getItem('yohaku-google-client')||globalThis.YohakuDeployment?.googleClientId||'';
  const bytesLabel=n=>!Number.isFinite(n)?'容量未計測':n>=1024**3?(n/1024**3).toFixed(2)+' GB':(n/1024**2).toFixed(1)+' MB';
  function driveStatus(message){$('mobileDriveStatus').textContent=message;}
  async function refresh(){
    $('mobilePageCount').textContent=S.book?`${S.page+1} / ${S.book.pages}`:'—';
    $('mobilePlay').textContent=S.playing?'Ⅱ':'▶';
    $('mobilePrev').disabled=!S.book||S.page===0;$('mobileNext').disabled=!S.book||S.page===S.book.pages-1;
    $('mobilePlay').disabled=!S.book;
    if(!isLocalPC&&S.book){
      const synced=new Set(JSON.parse(localStorage.getItem('yohaku-synced:'+S.book.id)||'[]'));
      const pending=(await bookOps(S.book.id)).filter(o=>!synced.has(o.id)&&o.kind!=='position').length;
      $('connectionStatus').textContent=`${navigator.onLine?'オンライン':'オフライン'} · メモ等の同期待ち ${pending}件`;
    }
  }
  async function storageInfo(){
    const s=await navigator.storage?.estimate?.(),persisted=await navigator.storage?.persisted?.();
    $('deviceStorage').textContent=s?`このアプリの端末使用量：約 ${bytesLabel(s.usage)} ／ 保存枠の残り目安 ${bytesLabel(s.quota-s.usage)}。${persisted?'永続保存の許可あり。':'永続保存は未保証です。'} ブラウザのデータ削除はしないでください。`:'端末の空き容量を確認してください。';
    $('offlineShellStatus').textContent=navigator.serviceWorker?.controller?'アプリ画面のオフライン準備：完了（本の取得は別です）':'アプリ画面のオフライン準備：確認中。オンラインで一度開き直してから持ち出してください。';
  }
  async function openDrive(list=false){
    $('settingsDialog').close();if(!$('driveDialog').open)$('driveDialog').showModal();
    driveStatus($('driveStatus').textContent);await storageInfo();await refresh();
    if(list&&drive.connected)await listBooks();
  }
  async function connect(){
    if(!clientId()){$('driveDialog').close();$('settingsButton').click();$('googleClientId').focus();throw new Error('初回のみGoogle連携の設定が必要です。クライアントIDを設定してください。');}
    await drive.connect(clientId());await syncAll();await listBooks();
  }
  async function syncAll(){
    if(!drive.connected)throw new Error('先にGoogleに接続してください');
    if(!navigator.onLine)throw new Error('オフラインです。メモは端末に保存されています。');
    if(S.cloudSyncing)return;S.cloudSyncing=true;
    try{for(const b of S.books){
      const local=await bookOps(b.id),remote=await drive.sync(b.id,local);
      const merged=mergeOps(await bookOps(b.id),remote);await storeOps(merged);
      // Only mark the snapshot we actually sent as synced; edits made in flight remain pending.
      localStorage.setItem('yohaku-synced:'+b.id,JSON.stringify(mergeOps(local,remote).map(o=>o.id)));
      if(S.book?.id===b.id){S.ops=merged;renderNotes();renderAnnotations();await syncPC();}
    }await refresh();}finally{S.cloudSyncing=false;}
  }
  async function withTransfer(fn){
    if(S.busy)throw new Error('別の転送・準備が進行中です');
    S.busy=true;transfer=true;cancelled=false;$('cancelTransfer').hidden=false;
    try{try{wakeLock=await navigator.wakeLock?.request('screen');}catch{}
      await fn();
    }catch(e){if(e.name==='QuotaExceededError')throw new Error('端末の保存容量が足りません。空きを増やして同じ本の取得を再開してください。既存の本・メモは残しています。');throw e;
    }finally{await wakeLock?.release().catch(()=>{});wakeLock=null;S.busy=false;transfer=false;$('cancelTransfer').hidden=true;taskDone();await storageInfo();}
  }
  async function receive(manifest){
    const estimate=await navigator.storage?.estimate?.();
    // Base64 strings and IndexedDB bookkeeping vary by browser. Reserve conservatively.
    const needed=Number(manifest.totals?.bytes||0)*2.2;
    if(estimate&&needed>estimate.quota-estimate.usage&&!confirm(`空き容量が不足する可能性があります。保存枠の空き：約 ${bytesLabel(estimate.quota-estimate.usage)}、必要量の余裕を含む目安：約 ${bytesLabel(needed)}。続けますか？`))return;
    if(!confirm(`「${manifest.book.title}」をこの端末に保存します。\n転送量：約 ${bytesLabel(manifest.totals?.bytes)}\n取得中はアプリを開いたままにしてください。続けますか？`))return;
    await withTransfer(async()=>{
      const id=manifest.book.id,key=p=>`${id}:drive:${manifest.pageFiles[p]}`;
      // Stage immutable pages. A single book-pointer commit switches versions only after ALL pages arrive.
      await drive.receiveBook(manifest,p=>rawGet('assets',key(p)),(p,a)=>put('assets',{...a,id:key(p),bookId:id,page:p}),validateAsset,task,{cancelled:()=>cancelled});
      await put('books',{...manifest.book,portable:true,drivePageFiles:manifest.pageFiles,driveManifest:manifest.id,downloadedAt:Date.now(),driveTotals:manifest.totals});
      await refreshBooks();await openBook(id);
      $('driveDialog').close();toast(`全${manifest.book.pages}ページを端末に保存しました。音声は${manifest.totals?.audio??'準備済み'}ページ分です。`);
    });
  }
  async function listBooks(){
    if(!drive.connected)throw new Error('先にGoogleに接続してください');
    const list=$('mobileCloudBooks');list.textContent='本を確認しています…';
    const manifests=await drive.books();list.replaceChildren();
    if(!manifests.length){list.textContent='まだ本がありません。PCの余白で本を開き「この本をDriveへ保存・更新」を押してください。';return;}
    for(const m of manifests){
      const item=document.createElement('article');item.className='cloudBook';
      const title=document.createElement('strong');title.textContent=m.book.title;
      const local=await rawGet('books',m.book.id),done=local?.driveManifest===m.id;
      const p=document.createElement('p');p.textContent=`${m.book.pages}ページ ／ 音声 ${m.totals?.audio??'未計測'}ページ ／ 転送量 ${bytesLabel(m.totals?.bytes)}${m.totals?.outdated?` ／ 以前の文章・設定の音声 ${m.totals.outdated}ページ`:''}${done?' · この端末に保存済み':local?' · 更新または再取得できます':''}`;
      item.append(title,p,button(done?'保存済みの本を開く':'この１冊を端末に保存・再開',()=>done?($('driveDialog').close(),openBook(m.book.id)):receive(m),'primary'));
      list.append(item);
    }
  }
  async function upload(){
    const book=requireBook();requirePC();if(!drive.connected)throw new Error('先にGoogleに接続してください');
    if(S.busy)throw new Error('別の処理が進行中です');
    if(!await window.YohakuAI.confirmPortable())return;
    if(!confirm('この本の画像・文章・保存済み音声を、ご自身のGoogle Driveの余白専用領域に保存します。未生成の音声は含まれません。続けますか？'))return;
    await withTransfer(async()=>{
      const key=`yohaku-upload:${clientId()}:${book.id}`;
      const previous=JSON.parse(localStorage.getItem(key)||'null')||(await drive.books()).find(b=>b.book.id===book.id);
      const checkpoint=value=>localStorage.setItem(key,JSON.stringify(value));
      const result=await drive.uploadBook(book,p=>loadPageAsset(book,p),task,{previous,cancelled:()=>cancelled,checkpoint});
      checkpoint(result);await syncAll();driveStatus(`Driveへ保存済み：全${book.pages}ページ、音声${result.totals.audio}ページ、約${bytesLabel(result.totals.bytes)}。スマホでこの本を取得できます。`);
      await listBooks();toast('Driveへの保存が完了しました。');
    });
  }
  async function saveCorrection(){
    const book=requireBook(),page=S.page,after=$('ocrText').value;
    const a=await get('assets',`${book.id}:${page}`),before=a?.ocr?.text||'';
    if(after===before)throw new Error('文章は元の保存内容と同じです');
    await addOp('note',{text:'文章の修正依頼（PCで確認・反映）',correction:{before,after}},true,page,book.id);
    if(S.book?.id===book.id&&S.page===page){S.ocr={...S.ocr,text:after};window.YohakuAI?.pageLoaded(S.ocr);}
    toast('修正記録を端末に保存しました。接続中はDriveへ同期します。音声の変更はPCで反映・再生成した後です。');syncAll().catch(()=>{});
  }
  function textForPage(value){
    const pending=activeOps(S.ops).filter(o=>o.page===S.page&&o.correction&&!S.ops.some(a=>a.resolvedCorrection===o.id)).at(-1);
    return pending&&pending.correction.before===value.text?{...value,text:pending.correction.after,source:'端末での修正・PC反映待ち'}:value;
  }
  function noteActions(card,op){
    if(!op.correction)return;
    const detail=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre');summary.textContent='修正前・修正後を見る';text.textContent=`修正前\n${op.correction.before}\n\n修正後\n${op.correction.after}`;detail.append(summary,text);card.append(detail);
    if(!localBook()||S.ops.some(o=>o.resolvedCorrection===op.id))return;
    card.append(button('修正を確認してPCの文章へ反映',async()=>{
      const id=op.bookId,v=await api(`/api/books/${id}/text/${op.page}`);
      if(v.text!==op.correction.before&&v.text!==op.correction.after)throw new Error('PCでも文章が更新されています。自動上書きはしません。修正前・後とPCの文章を比べ、必要な箇所を手で反映してください。');
      if(!confirm(`PDF ${op.page+1}ページの修正を反映します。音声は後でPCで再生成してください。\n\n${op.correction.after.slice(0,1200)}`))return;
      if(v.text!==op.correction.after)await api(`/api/books/${id}/edit`,{page:op.page,text:op.correction.after,revision:v.revision});
      await addOp('note',{text:'文章の修正をPCへ反映済み（音声は再生成が必要）',resolvedCorrection:op.id},true,op.page,id);
      if(S.book?.id===id&&S.page===op.page)await showPage(op.page,false);
      S.audioCache.clear();toast('PCの文章へ反映しました。音声を更新し、Driveの本も更新してください。');
    },'subtle'));
  }
  function configureMobile(){
    if(isLocalPC)return;
    document.body.classList.add('mobile-edition','library-closed','notebook-closed');$('mobileReaderBar').hidden=false;
    $('importButton').hidden=true;$('welcomeImport').textContent='Google Driveから本を取得';$('welcomeImport').onclick=null;
    // Prevent the older PDF import handler. This entry opens the cloud shelf instead.
    $('welcomeImport').addEventListener('click',e=>{e.stopImmediatePropagation();openDrive().catch(report);},true);
    $('audioStatus').textContent='保存済みの音声を聴く';$('audioDetail').textContent='生成済み音声のみ。読み方の変更はPCで再生成します。';
    $('saveOcr').textContent='修正記録を保存（PCへ同期）';
    const listening=$('listenMode').closest('label');$('ocrText').before(listening);$('listenMode').value=prefs.listenMode||'instant';
    for(const id of ['openIssuesShortcut','ocrMode','ocrButton','updatePageAudio','openIssues','propagateEdit','prepareButton','checkPortable','exportAudioMode','exportPack','uploadBook','mobileUpload'])$(id).hidden=true;
    document.querySelectorAll('#ocrPanel>.aiBox,#ocrPanel>details,#ocrPanel>p.hint').forEach(el=>el.hidden=true);
    const help=document.createElement('p');help.className='hint';help.textContent='文章を直して保存すると、PCへ同期する修正記録になります。音声はここでは作り直しません。読み間違いはメモに「単語 → 正しい読み方」を残してください。';$('ocrText').before(help);
    $('exportAudioMode').closest('label').hidden=true;
    const questionHelp=document.createElement('p');questionHelp.className='hint';questionHelp.textContent='上の文章から言葉を選び、ChatGPTまたはGeminiを押してください。質問文をコピーしてブラウザを開きます。貼り付けて、ご自身で送信します。';$('ocrPanel').querySelector('.aiButtons').before(questionHelp);
    const first=$('settingsDialog').querySelector('.dialogBody');
    for(const child of [...first.children]){if(child.tagName==='H3'&&child.textContent.includes('スマホ・PC'))break;child.hidden=true;}
    document.querySelectorAll('[data-tab="ocr"]').forEach(el=>el.textContent='文章・質問');
  }
  function ready(){configureMobile();refresh();setInterval(()=>refresh().catch(()=>{}),1200);setInterval(()=>{if(drive.connected&&navigator.onLine)syncAll().catch(e=>driveStatus(e.message));},30000);}
  bind('driveShelfButton',()=>openDrive());bind('mobileConnectDrive',connect);bind('mobileListBooks',listBooks);bind('mobileSync',syncAll);bind('mobileUpload',upload);
  bind('driveSettings',()=>{$('driveDialog').close();$('settingsButton').click();});
  bind('cancelTransfer',()=>{cancelled=true;driveStatus('現在のページが保存されたら中断します。');});
  bind('mobileShelf',()=>{document.body.classList.toggle('library-closed');document.body.classList.add('notebook-closed');});
  bind('mobileNotes',()=>{$('notebookToggle').click();});bind('mobilePrev',()=>showPage(S.page-1));bind('mobileNext',()=>showPage(S.page+1));bind('mobilePlay',()=>$('playButton').click());
  window.addEventListener('online',()=>{if(drive.connected)syncAll().catch(()=>{});refresh();});
  $('driveDialog').addEventListener('cancel',e=>{if(transfer){e.preventDefault();toast('転送中です。中断ボタンで保存済みを残して停止できます。');}});
  return {ready,refresh,driveStatus,openDrive,upload,syncAll,saveCorrection,textForPage,noteActions};
})();
