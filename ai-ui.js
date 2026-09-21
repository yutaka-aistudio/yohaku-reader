'use strict';
/* The optional AI interface shares the reader's existing state and annotation store. */
window.YohakuAI=(()=>{
  let dirty=false,polling=false,lastPrep=null,reviewRows=[],replaceRows=[],initialized=false,savedPlan=null,savedPlanKey='';
  const stateNames={empty:'未OCR',ocr:'OCR済み・未確認',unreviewed:'AI修正済み・未確認',confirmed:'確認済み'};
  function options(){return {aiEnabled:prefs.aiEnabled??S.config.settings?.aiEnabled??true,aiModel:$('pageAiModel').value||'gemma4:12b',aiMethod:'assisted',listenMode:$('listenMode').value||'reviewed'};}
  function initialize(){if(initialized)return;initialized=true;const cfg=S.config.settings||{};
    $('pageAiModel').value=prefs.aiModel||cfg.aiModel||'gemma4:12b';$('listenMode').value=prefs.listenMode||cfg.listenMode||'reviewed';$('aiEnabled').checked=prefs.aiEnabled??cfg.aiEnabled??true;
    connectionChanged();
    setInterval(()=>poll().catch(()=>{}),1800);
  }
  function connectionChanged(){$('correctAI').disabled=!S.backend;$('aiEngineStatus').textContent=S.backend?'PCに接続しました。AIの状態は設定を開くと確認できます。':isLocalPC?'PCサーバー未接続。「余白を起動.vbs」を開いてください。':'AI校正・新しい音声の生成はPC側で行います。';}
  function allowPageChange(){if(!dirty)return true;if(!confirm('編集中のOCR文章は未保存です。ページを移動して編集を破棄しますか？'))return false;dirty=false;return true;}
  function pageLoaded(value){dirty=false;savedPlanKey='';$('backgroundPanel').hidden=true;renderStatus(value);if(localBook())api(`/api/books/${S.book.id}/priority`,{page:S.page}).catch(()=>{});poll().catch(()=>{});refreshExportResult().catch(()=>{});}
  function renderStatus(value){$('candidateText').textContent=value.candidate?.text||'AI候補はまだありません。';
    $('aiPageStatus').textContent=[stateNames[value.reviewState]||value.source,value.candidate?`${value.candidate.model} / ${value.candidate.seconds}秒`:'',...(value.candidate?.warnings||[]),value.positionApproximate?'文字選択位置は一部概算です。対応しない文字は下のテキスト欄から選択してください。':''].filter(Boolean).join(' · ');
    if(value.candidate?.method)$('pageAiMethod').value=value.candidate.method;
  }
  async function settingsOpened(){$('aiEnabled').checked=options().aiEnabled;if(!S.backend)return;const info=await api('/api/ai/status');$('aiEngineStatus').textContent=info.ready?info.models.map(m=>`${m.label}：${m.installed?'使用可能':'未検出'}`).join(' / '):info.message;}
  function preparationPreset(){const preset=$('preparePreset').value;if(preset==='custom')return;$('prepareAI').checked=preset!=='ocr';$('prepareAudio').checked=['sample','full'].includes(preset);$('prepareStart').value=preset==='sample'?S.page+1:1;$('prepareEnd').value=preset==='sample'?Math.min(S.book.pages,S.page+10):S.book.pages;}
  $('preparePreset').onchange=preparationPreset;
  for(const id of ['prepareAI','prepareAudio'])$(id).onchange=()=>{$('preparePreset').value='custom';};
  function openPrepare(){requirePC();$('preparePreset').value='ocr';preparationPreset();$('prepareListenMode').value=options().listenMode;
    $('prepareSummary').textContent=`AI：${$('pageAiModel').selectedOptions[0].textContent} / 声：${S.config.voices?.find(v=>v.id===speechOptions().narrator)?.label||speechOptions().narrator}。AI・声を変える場合は閉じて設定してください。`;
    $('prepareDialog').showModal();}
  async function startPrepare(resume=false){requirePC();const book=S.book,opts=resume?{resume:true}: {...speechOptions(),start:Number($('prepareStart').value)-1,end:Number($('prepareEnd').value),aiEnabled:$('prepareAI').checked,audio:$('prepareAudio').checked,listenMode:$('prepareListenMode').value};
    const plan=await api(`/api/books/${book.id}/prepare-plan`,opts);
    const message=`${resume?'前回の声・読み方辞書・AI設定で再開します。':'現在の設定で準備します。'}\n保存済みOCR：${plan.ocrReady}/${plan.total}ページ\n再利用する文章：${plan.textReady}ページ／準備が必要：${plan.textRemaining}ページ\n`+(plan.options.audio?`再利用する音声：${plan.audioReady}ページ／準備が必要：${plan.audioRemaining}ページ\nうち、文章・声・辞書などが合わない保存音声：${plan.changedAudio}ページ\n`:'')+'不足分の準備を開始しますか？';
    if(!confirm(message))return;
    await api(`/api/books/${book.id}/prepare`,resume?{resume:true}:{...plan.options});$('prepareDialog').close();savedPlanKey='';await poll();toast('保存済みを再利用し、不足分の準備を始めました。');}
  async function poll(){if(polling||!localBook())return;polling=true;const id=S.book.id,page=S.page;
    try{const result=await api(`/api/books/${id}/preparation`);if(S.book?.id!==id)return;lastPrep=result;if(!result.id){$('backgroundPanel').hidden=true;return;}
      $('backgroundPanel').hidden=false;const running=['running','queued'].includes(result.state);
      const key=id+result.id+result.state;
      if(!running&&savedPlanKey!==key){savedPlan=await api(`/api/books/${id}/prepare-plan`,{resume:true});savedPlanKey=key;if(S.book?.id!==id)return;}
      const counts=!running&&savedPlanKey===key?savedPlan:result;
      renderPreparation(result,counts);
      if(!dirty&&!S.playing){const v=await api(`/api/books/${id}/text/${page}`);if(S.book?.id===id&&S.page===page&&!dirty&&v.revision!==S.ocr?.revision){S.ocr=v;$('ocrText').value=v.text;$('ocrSource').textContent=v.source;renderTextLayer();renderStatus(v);S.audioCache.clear();}}
    }finally{polling=false;}}
  function renderPreparation(result,counts){
    const v=YohakuProgress.summarize(result,counts),t=result.stageSeconds||{},opts=counts.options||result.options||{};
    $('backgroundPanel').dataset.warning=String(!v.running&&v.remaining>0);
    $('backgroundLabel').textContent=v.label;
    $('backgroundCount').textContent=`${v.audio?'音声':'文章'} ${v.ready} / ${v.total}ページ`;
    $('backgroundPercent').textContent=`${v.percent}%`;$('backgroundBar').value=v.percent;
    $('backgroundCounts').textContent=`残り ${v.remaining}ページ ／ 失敗 ${v.failedPages.length}ページ`+(v.waitingReview?` ／ 確認待ち ${v.waitingReview}ページ`:'');
    $('backgroundActivity').textContent=v.activity;
    $('backgroundElapsed').textContent=v.elapsed;
    $('backgroundDetailsLabel').textContent=v.failedPages.length?`失敗ページ：${v.failedPages.map(p=>p+1).join('・')}（詳細）`:'処理の詳細';
    $('backgroundDetail').textContent=`対象：${opts.pages?'選択した'+v.total+'ページ':`PDF ${(opts.start||0)+1}〜${opts.end||v.total}ページ`}\n文章 ${v.textReady}/${v.total}ページ保存済み`+(v.audio?` ／ 音声 ${v.audioReady}/${v.total}ページ保存済み`:' ／ 音声は今回の処理対象外')+`\n前回と同じ声・辞書・AI設定で不足分だけ再開します。\n開始時から再利用：文章 ${result.reusedText||0}／音声 ${result.reusedAudio||0}ページ\n累計処理時間：OCR ${Math.round(t.ocr||0)}秒 ／ AI ${Math.round(t.ai||0)}秒 ／ 音声 ${Math.round(t.audio||0)}秒（並行処理のため合計と経過時間は異なります）`;
    const signature=JSON.stringify(v.errors);if($('backgroundErrors').dataset.signature!==signature){$('backgroundErrors').dataset.signature=signature;$('backgroundErrors').replaceChildren();for(const e of v.errors){const p=document.createElement('p');p.className='progressError';p.textContent=`PDF ${e.page+1}ページ：${e.stage==='audio'?'音声':'文章'}の処理失敗\n${e.error}`;$('backgroundErrors').append(p);}}
    $('cancelPrepare').hidden=!v.running;$('resumePrepare').hidden=v.running||v.remaining===0;$('resumePrepare').textContent=v.resumeLabel;
  }
  async function correct(){requirePC();if(dirty)throw new Error('編集中の文章を先に保存するか、元に戻してください。');const id=S.book.id,page=S.page;$('correctAI').disabled=true;
    try{const v=await waitJob(await api(`/api/books/${id}/ai`,{page,...speechOptions(),aiMethod:$('pageAiMethod').value,forceAI:true,savePageMethod:true}));S.audioCache.clear();
      if(S.book?.id===id&&S.page===page){if(!dirty){S.ocr=v;$('ocrText').value=v.text;$('ocrSource').textContent=v.source;renderTextLayer();}renderStatus(v);}
      toast(v.notice||'AI候補を保存しました。手修正・確認済みの文章は上書きしていません。');
    }finally{$('correctAI').disabled=false;}}
  async function openReview(){requirePC();$('reviewStart').value=Math.max(1,S.page+1);$('reviewEnd').value=Math.min(S.book.pages,S.page+10);$('reviewDialog').showModal();await refreshReview();}
  async function refreshReview(){requirePC();const id=S.book.id;reviewRows=await api(`/api/books/${id}/review`);if(S.book?.id!==id)return;const list=$('reviewList');list.replaceChildren();
    const from=Number($('reviewStart').value)-1,to=Number($('reviewEnd').value);let shown=0;
    for(const row of reviewRows.filter(r=>r.page>=from&&r.page<to)){
      shown++;const card=document.createElement('section');card.className='reviewCard';const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.dataset.reviewPage=row.page;check.disabled=row.reviewState==='confirmed';
      label.append(check,` P.${row.page+1} · ${stateNames[row.reviewState]} · ${row.candidate.model}`);card.append(label);
      const detail=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`原本・元OCR・AI候補を見る（変更${row.diffs.length}箇所）`;detail.append(summary);
      const columns=document.createElement('div');columns.className='reviewColumns';const image=document.createElement('img');image.src=`/api/books/${id}/image/${row.page}`;image.alt=`原本 PDF ${row.page+1}ページ`;image.className='reviewImage';columns.append(image);
      for(const [name,text] of [['元OCR',row.original],['AI候補',row.candidate.text]]){const block=document.createElement('div');const h=document.createElement('strong');h.textContent=name;const pre=document.createElement('pre');pre.textContent=text;block.append(h,pre);columns.append(block);}detail.append(columns);
      for(const d of row.diffs){const p=document.createElement('p');p.className='diffLine';p.textContent=`元OCR：${d.before||'［文字なし］'} → AI：${d.after||'［削除］'}`;detail.append(p);}
      const warn=document.createElement('p');warn.className='hint';warn.textContent=(row.candidate.warnings||[]).join(' ');detail.append(warn);card.append(detail);
      card.append(button('このページを開いて手修正',async()=>{$('reviewDialog').close();await showPage(row.page);setTab('ocr');},'textButton'));list.append(card);
    }
    if(!shown)list.textContent='この範囲にAI候補はありません。先にAI校正を実行してください。';
  }
  async function approve(){const pages=[...document.querySelectorAll('[data-review-page]:checked')].map(c=>Number(c.dataset.reviewPage));const entries=reviewRows.filter(r=>pages.includes(r.page)).map(r=>({page:r.page,revision:r.revision,candidateId:r.candidate.id}));if(!entries.length)throw new Error('確認したページにチェックしてください');
    await api(`/api/books/${S.book.id}/approve`,{entries});S.audioCache.clear();await refreshReview();if(!dirty)await showPage(S.page,false);toast(`${entries.length}ページを確認済みにしました。必要な音声は次の再生・再準備で更新します。`);}
  async function portableStatus(){requireBook();let r;if(localBook()){const query=new URLSearchParams({narrator:speechOptions().narrator,voiceSpeed:speechOptions().voiceSpeed});r=await api(`/api/books/${S.book.id}/portable-status?${query}`);}else{r={total:S.book.pages,...await assetStats(S.book.id)};r.complete=r.images===r.total&&r.texts===r.total&&r.audio===r.total;}
    $('portableStatus').textContent=`画像 ${r.images}/${r.total} · テキスト ${r.texts}/${r.total} · 現在の設定に合う音声 ${r.audio}/${r.total} · 保存済み音声 ${r.savedAudio??r.audio}/${r.total} · 未確認 ${r.unreviewed}ページ。`+(r.complete?'全ページの持ち出し準備完了。':'途中まででもPCへ書き出せます。未生成ページは音声なしで読めます。')+(r.changedAudio?` ${r.changedAudio}ページは以前の文章・読み方・声の音声が保存されています。`:'');return r;}
  async function confirmPortable(audioMode='current'){const r=await portableStatus();const audio=audioMode==='saved'?(r.savedAudio??r.audio):r.audio;return confirm(`画像・文章と、保存済み音声 ${audio}/${r.total}ページを持ち出します。\n${r.total-audio}ページは音声なしです。未確認の文章：${r.unreviewed}ページ。`+(audioMode==='saved'&&r.changedAudio?`\n${r.changedAudio}ページには以前の読み方・声・文章の音声を含めます。`:'')+'\n続けますか？');}
  bind('correctAI',correct);bind('openReview',openReview);bind('refreshReview',refreshReview);bind('approveSelected',approve);
  async function refreshIssues(){requirePC();const book=S.book,query=new URLSearchParams({narrator:speechOptions().narrator,voiceSpeed:speechOptions().voiceSpeed});$('issuesSummary').textContent='保存済み結果を確認中…';const result=await api(`/api/books/${book.id}/issues?${query}`);if(S.book?.id!==book.id)return;const list=$('issuesList');list.replaceChildren();$('issuesSummary').textContent=`全${result.total}ページ中、未処理・要確認 ${result.rows.length}ページ。必要なページにチェックしてください。`;
    for(const row of result.rows){const card=document.createElement('div');card.className='issueRow';const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.dataset.issuePage=row.page;label.append(check,` PDF ${row.page+1}ページ`);const detail=document.createElement('small');detail.textContent=row.labels.join(' / ');label.append(detail);card.append(label,button('開いて修正',async()=>{const shown=await showPage(row.page);if(shown===false)return;$('issuesDialog').close();document.body.classList.remove('notebook-closed');setTab('ocr');$('ocrPanel').scrollTop=0;$('ocrText').focus();},'subtle'));list.append(card);}}
  async function openIssues(){requirePC();$('issuesDialog').showModal();await refreshIssues();}
  bind('openIssues',openIssues);bind('openIssuesShortcut',openIssues);bind('refreshIssues',refreshIssues);
  bind('progressIssues',openIssues);
  bind('retryIssues',async()=>{requirePC();if(dirty)throw new Error('編集中の文章を先に保存してください。');const pages=[...document.querySelectorAll('[data-issue-page]:checked')].map(x=>Number(x.dataset.issuePage));if(!pages.length)throw new Error('処理するページにチェックしてください。');const previous=await api(`/api/books/${S.book.id}/preparation`);if(['running','queued'].includes(previous.state))throw new Error('この本は準備中です。完了または中断後に再処理してください。');const retryStage=$('retryStage').value;if(!confirm(`選択した${pages.length}ページだけ「${$('retryStage').selectedOptions[0].textContent}」を行います。元PDF・手修正文は残します。続けますか？`))return;await api(`/api/books/${S.book.id}/prepare`,{...speechOptions(),start:0,end:S.book.pages,pages,retryStage});$('issuesDialog').close();savedPlanKey='';await poll();toast('選択したページだけ再処理を始めました。');});
  bind('updatePageAudio',async()=>{requirePC();if(dirty)throw new Error('文章を修正した場合は、先に「修正を保存」を押してください。');$('updatePageAudio').disabled=true;try{await waitJob(await api(`/api/books/${S.book.id}/speech`,{page:S.page,...speechOptions(),aiEnabled:false}));S.audioCache.clear();toast('このページの音声を保存しました。朗読ボタンで聴けます。');}finally{$('updatePageAudio').disabled=false;}});
  bind('cancelPrepare',async()=>{requirePC();await api(`/api/books/${S.book.id}/cancel-prepare`,{});toast('中断を依頼しました。実行中のページの処理後に停止します。');});
  bind('resumePrepare',()=>startPrepare(true));bind('checkPortable',portableStatus);
  bind('instantPlay',async()=>{requireBook();if(S.recording)throw new Error('録音を停止してください。');$('listenMode').value='instant';prefs.listenMode='instant';savePrefs();stopPlayback();S.playing=true;try{await playPage(S.page);}catch(e){stopPlayback();throw e;}});
  $('ocrText').addEventListener('input',()=>{dirty=true;});
  for(const id of ['pageAiModel','listenMode'])$(id).addEventListener('change',()=>{prefs.aiModel=$('pageAiModel').value;prefs.listenMode=$('listenMode').value;savePrefs();S.audioCache.clear();});
  $('aiEnabled').addEventListener('change',()=>{prefs.aiEnabled=$('aiEnabled').checked;savePrefs();});
  bind('useCandidate',()=>{if(!S.ocr?.candidate)throw new Error('AI候補がありません');if(dirty&&!confirm('編集中の文章をAI候補で置き換えますか？'))return;$('ocrText').value=S.ocr.candidate.text;dirty=true;toast('候補を編集欄へ入れました。確認して「修正を保存」を押してください。');});
  bind('propagateEdit',()=>{requirePC();$('replaceBefore').value=selectedText();$('replaceAfter').value='';$('replaceStart').value=Math.min(S.book.pages,S.page+2);$('replaceList').replaceChildren();replaceRows=[];$('replaceDialog').showModal();});
  bind('previewReplace',async()=>{const r=await api(`/api/books/${S.book.id}/replace-preview`,{start:Number($('replaceStart').value)-1,before:$('replaceBefore').value,after:$('replaceAfter').value});replaceRows=r.rows;const list=$('replaceList');list.replaceChildren();
    for(const row of replaceRows){const card=document.createElement('details'),summary=document.createElement('summary'),check=document.createElement('input');check.type='checkbox';check.dataset.replacePage=row.page;check.onclick=e=>e.stopPropagation();summary.append(check,` P.${row.page+1}（${row.count}箇所）`);card.append(summary);const pre=document.createElement('pre');pre.className='candidateText';pre.textContent='修正前：\n'+row.beforeText+'\n\n修正後：\n'+row.afterText;card.append(pre);list.append(card);}if(!replaceRows.length)list.textContent='読み取り済みの後続ページに一致する文字はありません。';});
  bind('applyReplace',async()=>{const selected=[...document.querySelectorAll('[data-replace-page]:checked')].map(x=>Number(x.dataset.replacePage));const entries=replaceRows.filter(r=>selected.includes(r.page));if(!entries.length)throw new Error('修正するページを選択してください');await api(`/api/books/${S.book.id}/replace-apply`,{entries});S.audioCache.clear();$('replaceDialog').close();toast(`${entries.length}ページを修正しました。未OCRのページは対象外です。`);});
  bind('previewVoice',async()=>{if(!S.backend)throw new Error('声の試聴生成はPCで行ってください');$('previewVoice').disabled=true;try{const r=await waitJob(await api('/api/voice-preview',{narrator:$('narrator').value,voiceSpeed:Number($('voiceSpeed').value)}));$('voicePreview').src=r.url;$('voicePreview').hidden=false;await $('voicePreview').play();}finally{$('previewVoice').disabled=false;}});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  return {options,initialize,connectionChanged,pageLoaded,allowPageChange,openPrepare,startPrepare,settingsOpened,confirmPortable,hasUnsaved:()=>dirty};
})();
