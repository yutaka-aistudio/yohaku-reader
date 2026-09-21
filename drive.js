/* User-authorized Drive appDataFolder only. No ChatGPT/Gemini API use. */
(function(root){
  const BASE='https://www.googleapis.com/drive/v3';
  const UPLOAD='https://www.googleapis.com/upload/drive/v3';
  const SCOPE='https://www.googleapis.com/auth/drive.appdata';
  class Drive {
    constructor(status){this.token=null;this.expires=0;this.status=status;this.writer=crypto.randomUUID();this.sent=new Map();this.files=new Map();}
    get connected(){return !!this.token && Date.now()<this.expires;}
    async connect(clientId){
      this.disconnect();
      if(!clientId.endsWith('.apps.googleusercontent.com')) throw new Error('GoogleのOAuthクライアントIDを先に設定してください');
      if(!window.isSecureContext) throw new Error('Google連携にはHTTPSのスマホ版、またはPCのlocalhost版を使ってください');
      if(!root.google?.accounts?.oauth2){
        await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.onload=resolve;s.onerror=()=>reject(new Error('Googleへの接続に失敗しました'));document.head.append(s);});
      }
      await new Promise((resolve,reject)=>{
        const client=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:SCOPE,include_granted_scopes:false,
          callback:r=>{if(r.error)return reject(new Error(r.error_description||r.error));
            if(!google.accounts.oauth2.hasGrantedAllScopes(r,SCOPE))return reject(new Error('Driveへの連携許可が必要です'));
            this.token=r.access_token;this.expires=Date.now()+Math.max(0,Number(r.expires_in)-60)*1000;resolve();},
          error_callback:e=>reject(new Error(e.type==='popup_closed'?'Google接続をキャンセルしました':'Googleのログイン画面を開けませんでした'))});
        client.requestAccessToken({prompt:'select_account'});
      });
      this.status('Googleに接続しました。起動中にメモを自動同期します。');
    }
    disconnect(){this.token=null;this.expires=0;this.sent.clear();this.files.clear();this.writer=crypto.randomUUID();this.status('接続を解除しました。端末内のメモは残っています。');}
    async request(url,options={}){
      if(!this.connected){this.status('Googleに再接続してください。未同期メモは端末内に保存されています。');throw new Error('Googleへの接続が必要です');}
      const r=await fetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${this.token}`}});
      if(r.status===401){this.token=null;this.status('Googleへの接続期限が切れました。再接続してください。');}
      if(!r.ok)throw new Error(`Drive同期に失敗しました (${r.status})。端末内のメモは残っています。`);
      return r;
    }
    async list(prefix){
      const escaped=prefix.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
      const all=[];let pageToken;
      do{
        const q=new URLSearchParams({spaces:'appDataFolder',q:`trashed = false and name contains '${escaped}'`,fields:'nextPageToken,files(id,name,modifiedTime)',pageSize:'1000'});
        if(pageToken)q.set('pageToken',pageToken);
        const result=await(await this.request(`${BASE}/files?${q}`)).json();all.push(...result.files);pageToken=result.nextPageToken;
      }while(pageToken);
      return all.filter(f=>f.name.startsWith(prefix));
    }
    async get(id){return(await this.request(`${BASE}/files/${encodeURIComponent(id)}?alt=media`)).json();}
    async put(name,value,id=null){
      const body=JSON.stringify(value);
      if(id){await this.request(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media`,{method:'PATCH',headers:{'Content-Type':'application/json'},body});return id;}
      const boundary='yohaku_'+crypto.randomUUID();
      const multipart=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,parents:['appDataFolder'],mimeType:'application/json'})}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const result=await(await this.request(`${UPLOAD}/files?uploadType=multipart&fields=id`,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body:multipart})).json();
      return result.id;
    }
    async sync(bookId,ops){
      const prefix=`yohaku.notes.${bookId}.`;
      const files=await this.list(prefix);let merged=ops;
      for(const file of files){
        const cached=this.files.get(file.id);
        if(cached?.time===file.modifiedTime){merged=YohakuCore.mergeOps(merged,cached.ops);continue;}
        const remote=await this.get(file.id);
        if(remote.schema!==1||remote.bookId!==bookId||!Array.isArray(remote.ops)||remote.ops.some(o=>o.bookId!==bookId))throw new Error('Driveのメモ形式を確認してください');
        merged=YohakuCore.mergeOps(merged,remote.ops);this.files.set(file.id,{time:file.modifiedTime,ops:remote.ops});
      }
      const signature=merged.map(o=>o.id).join('|');
      if(merged.length && this.sent.get(bookId)!==signature){
        const name=prefix+this.writer+'.json';
        const own=files.find(f=>f.name===name);
        await this.put(name,{schema:1,bookId,ops:merged},own?.id);this.sent.set(bookId,signature);
      }
      this.status(`Drive同期済み · ${new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}`);
      return merged;
    }
    async uploadBook(book,loadPage,progress,options={}){
      YohakuCore.safeBook(book);
      const version=crypto.randomUUID(),pageFiles=[],pageHashes=[];
      const previous=options.previous||{},available=new Set(options.previous?(await this.list(`yohaku.page.${book.id}.`)).map(f=>f.id):[]);
      const totals={bytes:0,audio:0,texts:0,outdated:0};
      for(let p=0;p<book.pages;p++){
        if(options.cancelled?.())throw new Error('Drive保存を中断しました。同じ本で再開すると、保存済みの同じ内容は再利用します。');
        progress(`Driveへ保存中 ${p+1} / ${book.pages} ページ`,100*p/book.pages);
        const page=await loadPage(p);
        if(!page.image)throw new Error(`${p+1}ページの画像が準備されていません`);
        const value={...page,schema:1,page:p};
        const bytes=new TextEncoder().encode(JSON.stringify(value));
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
        pageHashes.push(hash);totals.bytes+=bytes.length;totals.audio+=!!(page.audio||page.silent);totals.texts+=!!page.ocr;totals.outdated+=!!page.audioInfo?.outdated;
        const reusable=previous.pageHashes?.[p]===hash&&available.has(previous.pageFiles?.[p]);
        pageFiles.push(reusable?previous.pageFiles[p]:await this.put(`yohaku.page.${book.id}.${version}.${p}.json`,value));
        // Checkpoints contain file IDs/hashes, not images, text, audio or tokens.
        await options.checkpoint?.({bookId:book.id,pageFiles:[...pageFiles],pageHashes:[...pageHashes]});
      }
      if(options.cancelled?.())throw new Error('Drive保存を中断しました。再開できます。');
      await this.put(`yohaku.book.${book.id}.${version}.json`,{schema:1,book:{id:book.id,title:book.title,pages:book.pages,created:book.created},pageFiles,pageHashes,totals,created:Date.now()});
      progress(`Drive保存完了 ${book.pages} / ${book.pages} ページ`,100);
      this.status('本の持ち出し保存が完了しました。スマホで「Driveの持ち出し本を表示」から取得できます。');
      return {bookId:book.id,pageFiles,pageHashes,totals};
    }
    async receiveBook(manifest,loadLocal,saveLocal,validate,progress,options={}){
      YohakuCore.safeBook(manifest.book);
      if(manifest.schema!==1||!Array.isArray(manifest.pageFiles)||manifest.pageFiles.length!==manifest.book.pages)throw new Error('持ち出し本の形式が不正です');
      for(let page=0;page<manifest.book.pages;page++){
        if(options.cancelled?.())throw new Error('端末への取得を中断しました。同じ本を選ぶと保存済みから再開できます。');
        progress(`本を端末へ保存中 ${page+1} / ${manifest.book.pages}`,page/manifest.book.pages*100);
        const file=manifest.pageFiles[page],old=await loadLocal(page);
        // Each upload has immutable versioned page files. Resume only the same file.
        if(old?.drivePageFile===file&&old.image){validate(old,manifest.book.pages);continue;}
        const asset=await this.get(file);validate(asset,manifest.book.pages);
        if(asset.page!==page||!asset.image)throw new Error('ページの順序または画像が不正です');
        await saveLocal(page,{...asset,drivePageFile:file});
      }
      progress(`端末保存完了 ${manifest.book.pages} / ${manifest.book.pages} ページ`,100);
    }
    async books(){
      const files=await this.list('yohaku.book.');const latest=new Map();
      for(const f of files.sort((a,b)=>b.modifiedTime.localeCompare(a.modifiedTime))){
        const id=f.name.split('.')[2];if(latest.has(id))continue;
        const manifest=await this.get(f.id);YohakuCore.safeBook(manifest.book);
        if(manifest.schema!==1||!Array.isArray(manifest.pageFiles)||manifest.pageFiles.length!==manifest.book.pages)throw new Error('持ち出し本の形式が不正です');
        latest.set(id,{id:f.id,...manifest});
      }
      return [...latest.values()];
    }
  }
  root.YohakuDrive=Drive;
})(globalThis);
