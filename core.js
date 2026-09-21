/* Immutable annotation operations: union is lossless, idempotent, order-independent. */
(function (root) {
  function validateOp(op) {
    if(!op || typeof op.id!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(op.id) || !/^[a-f0-9]{32}$/.test(op.bookId) || !Number.isFinite(op.time) || !Number.isInteger(op.page) || op.page<0) throw new Error('注釈データが不正です');
    if(!['note','ink','highlight','question','position','delete'].includes(op.kind)) throw new Error('注釈の種類が不正です');
    if(op.text!==undefined && (typeof op.text!=='string'||op.text.length>100000)) throw new Error('メモの文字数が多すぎます');
    if(op.correction&&(op.kind!=='note'||typeof op.correction.before!=='string'||typeof op.correction.after!=='string'||op.correction.before.length>100000||op.correction.after.length>100000))throw new Error('文章の修正記録が不正です');
    if(op.resolvedCorrection!==undefined&&(typeof op.resolvedCorrection!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(op.resolvedCorrection)))throw new Error('修正確認の記録が不正です');
    if(op.kind==='delete'&&typeof op.target!=='string')throw new Error('削除マークが不正です');
    if(op.color&&!/^#[a-fA-F0-9]{6}$/.test(op.color))throw new Error('注釈の色が不正です');
    const normalized=x=>Number.isFinite(x)&&x>=0&&x<=1;
    if(op.kind==='ink'&&(!Array.isArray(op.points)||op.points.length>100000||op.points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(normalized))))throw new Error('手書きの座標が不正です');
    if(op.kind==='highlight'&&(!Array.isArray(op.rect)||op.rect.length!==4||!op.rect.every(normalized)))throw new Error('マーカーの座標が不正です');
    if(op.audio && (typeof op.audio!=='string'||op.audio.length>15000000||!/^data:audio\/(webm|mp4|wav|ogg|mpeg)(;codecs=[\w.-]+)?;base64,[a-zA-Z0-9+/=]+$/.test(op.audio)))throw new Error('音声メモの形式が不正です');
    return op;
  }
  function mergeOps(...groups) {
    const map = new Map();
    for (const op of groups.flat()) {
      validateOp(op);
      const old = map.get(op.id);
      if (old && JSON.stringify(old) !== JSON.stringify(op)) throw new Error('同じIDの異なる注釈があります。元データを保持して同期を停止しました');
      map.set(op.id, op);
    }
    return [...map.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }
  function activeOps(ops) {
    const removed = new Set(ops.filter(o => o.kind === 'delete').map(o => o.target));
    return ops.filter(o => !removed.has(o.id) && !['delete', 'position'].includes(o.kind));
  }
  function latestPosition(ops) {
    return mergeOps(ops).filter(o => o.kind === 'position').at(-1)?.page ?? 0;
  }
  function markdown(book, ops) {
    let out = `# ${book.title}\n\nページ番号はPDFの先頭を1ページとした番号です。\n\n`;
    const active = activeOps(ops).sort((a,b) => a.page-b.page || a.time-b.time);
    for (const o of active) {
      out += `## PDF ${o.page + 1} ページ · ${{note:'メモ',question:'疑問',highlight:'マーカー',ink:'手書き'}[o.kind]}\n\n`;
      out += (o.text || (o.kind === 'ink' ? '（手書きはバックアップ内に保存）' : o.kind === 'highlight' ? '（範囲マーカー）' : 'あとで確認')) + '\n\n';
      if(o.correction)out += '### 修正前\n\n'+o.correction.before+'\n\n### 修正後\n\n'+o.correction.after+'\n\n';
      if(o.audio) out += '（元音声はバックアップ内に保存）\n\n';
    }
    return out;
  }
  function safeBook(book) {
    if(!book || !/^[a-f0-9]{32}$/.test(book.id) || typeof book.title !== 'string' || !Number.isInteger(book.pages) || book.pages<1 || book.pages>20000) throw new Error('書籍データが不正です');
    return book;
  }
  // Percentages refer to the rendered page image, never to the changing sidebar width.
  function pageSize(imageWidth,imageHeight,availableWidth,availableHeight,mode='page') {
    if (![imageWidth,imageHeight,availableWidth,availableHeight].every(n=>Number.isFinite(n)&&n>0)) return null;
    const scale=mode==='page'?Math.min(availableWidth/imageWidth,availableHeight/imageHeight):
      mode==='fit'?availableWidth/imageWidth:mode==='height'?availableHeight/imageHeight:
      Math.max(10,Math.min(400,Number(mode)||100))/100;
    return {width:Math.floor(imageWidth*scale),height:Math.floor(imageHeight*scale),percent:scale*100};
  }
  const api = { mergeOps, activeOps, latestPosition, markdown, safeBook, validateOp, pageSize };
  root.YohakuCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
