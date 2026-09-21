(function(root){
  'use strict';
  const count=n=>Math.max(0,Number(n)||0);
  const duration=n=>{n=Math.floor(count(n));return `${Math.floor(n/60)}分${n%60}秒`;};
  function summarize(result,plan=null,now=Date.now()/1000){
    const running=['running','queued'].includes(result.state),counts=!running&&plan?plan:result;
    const options=counts.options||result.options||{},total=count(counts.total),audio=!!options.audio;
    const textReady=Math.min(total,count(counts.textReady)),audioReady=Math.min(total,count(counts.audioReady));
    const ready=audio?audioReady:textReady,remaining=Math.max(0,total-ready);
    const percent=total?Math.floor(ready/total*1000)/10:0;
    const errors=(result.errors||[]).filter(e=>{
      const saved=e.stage==='audio'?counts.readyAudioPages:counts.readyTextPages;
      return !Array.isArray(saved)||!saved.includes(e.page);
    });
    const failedPages=[...new Set(errors.map(e=>e.page))].sort((a,b)=>a-b);
    const elapsed=result.started?(running?now-result.started:result.elapsedSeconds||0):null;
    let label=running?(result.cancelRequested?'中断処理中（保存済みは残ります）':audio?'音声を準備中':'文章を準備中'):
      result.state==='done'?(remaining?`処理終了・${audio?'音声':'文章'}が${remaining}ページ未完成`:'指定範囲の準備がすべて完了'):
      result.state==='cancelled'||result.state==='interrupted'?'準備は中断しています':'準備を続けられませんでした';
    let activity=running?(result.message||'準備中…'):'処理は終了しています。待っていても数字は増えません。';
    if(!running&&!remaining)activity='保存済みです。';
    const a=result.audioActivity;
    if(running&&result.activeAudioPage!=null){
      activity=`音声：PDF ${result.activeAudioPage+1}ページ`;
      if(a?.stage==='waiting')activity+=' · VOICEPEAKの順番待ち';
      else if(a?.stage==='generating')activity+=` · ${a.chunkIndex+1}/${a.chunksTotal}区間目を生成中（${a.chunksDone}区間保存済み）`;
      else if(a?.stage==='assembling')activity+=' · 音声を結合・保存中';
      else activity+='を処理中';
      if(result.activeAudioStarted)activity+=` · このページ${duration(now-result.activeAudioStarted)}`;
      if(a?.stage==='generating'&&a.updated){activity+=` · この区間${duration(now-a.updated)}`;if(now-a.updated>=60)activity+='（処理待ち。1区間は最大180秒でタイムアウト）';}
    }
    const review=Math.min(remaining,count(counts.waitingReview));
    return {running,audio,total,textReady,audioReady,ready,remaining,percent,label,activity,failedPages,errors,
      waitingReview:review,elapsed:elapsed==null?'記録なし':duration(elapsed),
      resumeLabel:remaining?`残り${remaining}ページの${audio?'音声':'文章'}を作る`:'準備完了'};
  }
  const api={summarize,duration};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.YohakuProgress=api;
})(typeof globalThis!=='undefined'?globalThis:this);
