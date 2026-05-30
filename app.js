/* =========================================================
   脳栞 (noushiori) — 読む・捕獲・抽出・想起
   依存ゼロ / vanilla / PWA
   ========================================================= */
'use strict';

/* ---------- 小物 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const now = () => Date.now();
const DAY = 86400000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function toast(msg, ms = 1500) {
  const t = $('#toast'); if (!t) return; t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- ストレージ（IndexedDB / 失敗時はメモリ） ---------- */
const DB = (() => {
  const mem = { docs: new Map(), marks: new Map(), kv: new Map() };
  let memMode = false, dbp;
  function open() {
    if (dbp) return dbp;
    if (!self.indexedDB) { memMode = true; dbp = Promise.resolve(null); return dbp; }
    dbp = new Promise((res) => {
      let r;
      try { r = indexedDB.open('noushiori', 1); } catch (e) { memMode = true; return res(null); }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('marks')) db.createObjectStore('marks', { keyPath: 'id' }).createIndex('docId', 'docId', { unique: false });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => { memMode = true; res(null); };
      r.onblocked = () => { memMode = true; res(null); };
    });
    return dbp;
  }
  const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  async function os(store, mode) { const db = await open(); if (memMode || !db) return null; return db.transaction(store, mode).objectStore(store); }
  return {
    memMode: () => memMode,
    async put(store, val) { const o = await os(store, 'readwrite'); if (!o) { mem[store].set(val[store === 'kv' ? 'k' : 'id'], val); return; } return wrap(o.put(val)); },
    async get(store, key) { const o = await os(store, 'readonly'); if (!o) return mem[store].get(key); return wrap(o.get(key)); },
    async del(store, key) { const o = await os(store, 'readwrite'); if (!o) { mem[store].delete(key); return; } return wrap(o.delete(key)); },
    async all(store) { const o = await os(store, 'readonly'); if (!o) return [...mem[store].values()]; return wrap(o.getAll()); },
    async byIndex(store, idx, val) { const o = await os(store, 'readonly'); if (!o) return [...mem[store].values()].filter((v) => v[idx] === val); return wrap(o.index(idx).getAll(val)); },
  };
})();

/* ---------- 設定 ---------- */
const DEFAULTS = { cpm: 700, readSize: 21, serif: false, defaultMode: 'focus', recall: false, wakelock: true, theme: 'auto', noFade: false, markWidth: 1, seenHint: false };
let settings = { ...DEFAULTS };
async function loadSettings() {
  const rec = await DB.get('kv', 'settings');
  if (rec && rec.v) settings = { ...DEFAULTS, ...rec.v };
  applySettings();
}
async function saveSettings() { try { await DB.put('kv', { k: 'settings', v: settings }); } catch (e) {} }
function resolvedTheme() { return settings.theme !== 'auto' ? settings.theme : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); }
function applySettings() {
  const d = document.documentElement;
  d.style.setProperty('--read-size', settings.readSize + 'px');
  d.dataset.theme = settings.theme;
  document.body && document.body.classList.toggle('no-fade', !!settings.noFade);
  let meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolvedTheme() === 'light' ? '#f6f5f1' : '#0e0f13');
}

/* =========================================================
   Markdown / txt パース
   ========================================================= */
function normalizePara(lines) {
  let t = lines.join('\n');
  t = t.replace(/([^\x00-\x7F])\n([^\x00-\x7F])/g, '$1$2').replace(/\n+/g, ' ');
  return t.trim();
}
function parseDoc(raw, type) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const path = [];
  let i = 0;
  const flushPara = (buf) => { if (buf.length) { const t = normalizePara(buf); if (t) blocks.push({ type: 'para', text: t, headingPath: path.slice() }); } };

  if (type === 'txt') {
    let buf = [], listBuf = [];
    const flushList = () => { if (listBuf.length) { blocks.push({ type: 'list', items: listBuf.slice(), headingPath: path.slice() }); listBuf = []; } };
    for (const ln of lines) {
      const t = ln.trim();
      if (t === '') { flushPara(buf); buf = []; flushList(); continue; }
      const li = t.match(/^([・*+−-]|\d+[.)])\s+(.+)$/);
      if (li) { flushPara(buf); buf = []; listBuf.push(li[2].trim()); }
      else { flushList(); buf.push(ln); }
    }
    flushPara(buf); flushList();
    return blocks;
  }

  let para = [];
  while (i < lines.length) {
    const ln = lines[i]; const t = ln.trim();
    const fence = t.match(/^(```|~~~)/);
    if (fence) {
      flushPara(para); para = [];
      const f = fence[1]; const code = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(f)) { code.push(lines[i]); i++; }
      i++; blocks.push({ type: 'code', text: code.join('\n'), headingPath: path.slice() }); continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(para); para = [];
      const lv = h[1].length; const txt = h[2].replace(/#+\s*$/, '').trim();
      path.length = lv - 1; path[lv - 1] = txt;
      blocks.push({ type: 'heading', level: lv, text: txt, headingPath: path.slice(0, lv) }); i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,}|―{2,}|ーー+)$/.test(t)) { flushPara(para); para = []; i++; continue; } // 水平線は無視
    if (/^\|.*\|/.test(t)) {
      flushPara(para); para = [];
      const tbl = [];
      while (i < lines.length && /^\s*\|.*\|/.test(lines[i])) { tbl.push(lines[i].trim()); i++; }
      blocks.push({ type: 'table', text: tbl.join('\n'), headingPath: path.slice() }); continue;
    }
    if (/^>\s?/.test(t)) {
      flushPara(para); para = [];
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push({ type: 'quote', text: normalizePara(q), headingPath: path.slice() }); continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(ln)) {
      flushPara(para); para = [];
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim()); i++; }
      blocks.push({ type: 'list', items, headingPath: path.slice() }); continue;
    }
    if (t === '') { flushPara(para); para = []; i++; continue; }
    para.push(ln); i++;
  }
  flushPara(para);
  return blocks;
}

/* ---------- 文分割（括弧深度を考慮） ---------- */
const OPEN = '「『（(【〔《〈“‘';
const CLOSE = '」』）)】〕》〉”’';
const ENDERS = '。．！？!?…';
function splitSentences(text) {
  const arr = [...String(text || '').trim()];
  if (!arr.length) return [];
  const out = []; let buf = ''; let depth = 0;
  for (let i = 0; i < arr.length; i++) {
    const ch = arr[i]; buf += ch;
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) { if (depth > 0) depth--; }
    else if (ENDERS.includes(ch) && depth === 0) {
      while (i + 1 < arr.length && (ENDERS.includes(arr[i + 1]) || CLOSE.includes(arr[i + 1]))) { i++; buf += arr[i]; }
      out.push(buf.trim()); buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [arr.join('')];
}

/* ---------- 生URL等のノイズ除去（分割前に適用） ---------- */
function stripUrls(t) {
  return String(t || '')
    .replace(/https?:\/\/[^\s）)」』、。]+/g, '')   // 生URL
    .replace(/（\s*）|\(\s*\)/g, '')                  // 空になった括弧
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([、。）」』])/g, '$1');
}
/* ---------- md装飾の除去（表示・捕獲用プレーン化） ---------- */
function stripMd(text) {
  let s = stripUrls(text);
  s = s.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '');
  s = s.replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  return s;
}
function inlineMd(text) {
  let h = esc(text);
  h = h.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '');
  h = h.replace(/https?:\/\/[^\s）)」』、。<]+/g, '');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  h = h.replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  return h;
}

/* ---------- 日本語 文節ヒューリスティック分割（フラッシュ用） ---------- */
function charClass(ch, prev, next) {
  if (/[一-鿿々〆〇]/.test(ch)) return 'k';
  if (/[ぁ-ゟ]/.test(ch)) return 'h';
  if (/[゠-ヿｦ-ﾟー]/.test(ch)) return 'K';
  if (/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(ch)) return 'a';
  if (/[.,，．]/.test(ch) && /[0-9０-９]/.test(prev || '') && /[0-9０-９]/.test(next || '')) return 'a';
  if (OPEN.includes(ch)) return 'o';
  if (CLOSE.includes(ch)) return 'c';
  if (/[、。．！？!?…・]/.test(ch)) return 'p';
  return 's';
}
const PARTICLES = new Set(['を', 'は', 'が', 'に', 'へ', 'と', 'で', 'も', 'の', 'や', 'か']);
function segmentJa(text, min = 6, max = 16) {
  const arr = [...String(text || '')];
  if (arr.length <= max) return arr.length ? [arr.join('')] : [];
  const cls = (i) => (i < 0 || i >= arr.length) ? 's' : charClass(arr[i], arr[i - 1], arr[i + 1]);
  const segs = []; let cur = '';
  for (let i = 0; i < arr.length; i++) {
    const c = cls(i); const pc = i ? cls(i - 1) : null;
    const isContent = (c === 'k' || c === 'K' || c === 'a' || c === 'o');
    if (cur && isContent && (pc === 'h' || pc === 'p' || pc === 'c')) { segs.push(cur); cur = ''; }
    cur += arr[i];
    if (c === 'p' && cls(i + 1) !== 'p') { segs.push(cur); cur = ''; }
  }
  if (cur) segs.push(cur);
  const out = [];
  for (const seg of segs) {
    let a = [...seg];
    while (a.length > max) {
      let cut = -1;
      for (let j = Math.min(max, a.length - 1); j > min; j--) { if (PARTICLES.has(a[j - 1])) { cut = j; break; } }
      if (cut < 0) for (let j = Math.min(max, a.length - 1); j > min; j--) { const cc = charClass(a[j - 1], a[j - 2], a[j]); if (cc === 'h' || cc === 'p' || cc === 'c') { cut = j; break; } }
      if (cut < 0) for (let j = Math.min(max, a.length - 1); j > min; j--) { if (charClass(a[j - 1]) !== charClass(a[j])) { cut = j; break; } }
      if (cut < 0) cut = Math.floor((min + max) / 2);
      out.push(a.slice(0, cut).join('')); a = a.slice(cut);
    }
    const tail = a.join('');
    if (out.length && ([...out[out.length - 1]].length + a.length) <= max && [...out[out.length - 1]].length < min) out[out.length - 1] += tail;
    else if (tail) out.push(tail);
  }
  return out.filter(Boolean);
}
function orpIndex(len) { return len <= 1 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : 3; }

/* =========================================================
   units 構築
   ========================================================= */
function buildUnits(blocks) {
  const units = [];
  const push = (o) => { o.plain = o.role === 'head' || o.role === 'code' || o.role === 'table' ? o.text : stripMd(o.text); units.push(o); };
  blocks.forEach((b, bi) => {
    if (b.type === 'heading') push({ role: 'head', level: b.level, text: b.text, hp: b.headingPath, bi, blockText: b.text, paceable: true });
    else if (b.type === 'code' || b.type === 'table') push({ role: b.type, text: b.text, hp: b.headingPath, bi, blockText: b.text, paceable: false });
    else if (b.type === 'list') b.items.forEach((it, ii) => { const c = stripUrls(it); splitSentences(c).forEach((s) => push({ role: 'li', text: s, hp: b.headingPath, bi, ii, blockText: c, paceable: true })); });
    else { const c = stripUrls(b.text); splitSentences(c).forEach((s) => push({ role: b.type === 'quote' ? 'quote' : 'sent', text: s, hp: b.headingPath, bi, blockText: c, paceable: true })); }
  });
  return units;
}

/* =========================================================
   リーダー エンジン
   ========================================================= */
const R = {
  doc: null, units: [], paceable: [], chunks: {}, markedUnits: new Set(),
  mode: 'focus', cur: 0, curChunk: 0, playing: false, raf: 0, deadline: 0,
  wakelock: null, _wasPlaying: false, _recallPending: false,
};
function paceIndexOf(u) { return R.paceable.indexOf(u); }
function nextPace(u) { for (let k = u + 1; k < R.units.length; k++) if (R.units[k].paceable) return k; return -1; }
function prevPace(u) { for (let k = u - 1; k >= 0; k--) if (R.units[k].paceable) return k; return -1; }
function chunksOf(u) { if (R.chunks[u]) return R.chunks[u]; const c = segmentJa(R.units[u].plain); R.chunks[u] = c.length ? c : [R.units[u].plain]; return R.chunks[u]; }

async function openReader(docId) {
  const doc = await DB.get('docs', docId);
  if (!doc) return;
  R.doc = doc;
  R.units = buildUnits(doc.blocks);
  R.paceable = R.units.map((u, i) => (u.paceable ? i : -1)).filter((i) => i >= 0);
  R.chunks = {}; R._recallPending = false; R._wasPlaying = false; R._lastRecallPace = -999;
  R.mode = settings.defaultMode;
  if (!R.paceable.length) R.mode = 'free';
  R.cur = clamp(doc.pos || R.paceable[0] || 0, 0, Math.max(0, R.units.length - 1));
  if (R.units[R.cur] && !R.units[R.cur].paceable && R.paceable.length) R.cur = R.paceable[0];
  R.curChunk = 0; R.playing = false;
  const marks = await DB.byIndex('marks', 'docId', docId);
  R.markedUnits = new Set();
  marks.filter((m) => m.type !== 'recall').forEach((m) => {
    if (m.span && typeof m.span.start === 'number') { for (let k = m.span.start; k <= m.span.end; k++) R.markedUnits.add(k); }
    else if (typeof m.unitIndex === 'number' && m.unitIndex >= 0) R.markedUnits.add(m.unitIndex);
  });
  $('#reader').hidden = false;
  $('#reader-flow').classList.toggle('is-serif', settings.serif);
  setMode(R.mode, true);
  acquireWakeLock();
  if (!settings.seenHint) $('#hint').hidden = false;
}
function closeReader() { pause(); releaseWakeLock(); saveProgress(); $('#reader').hidden = true; renderLibrary(); }
async function saveProgress() {
  if (!R.doc) return;
  R.doc.pos = R.cur;
  R.doc.progress = R.paceable.length ? clamp((paceIndexOf(R.cur) + 1) / R.paceable.length, 0, 1) : 0;
  R.doc.updatedAt = now();
  try { await DB.put('docs', R.doc); } catch (e) {}
}

function setMode(mode, force) {
  pause();
  if (!force && mode === R.mode) return;
  R.mode = mode;
  $('#reader-mode').textContent = mode === 'focus' ? '集中' : mode === 'flash' ? 'フラッシュ' : '自由';
  const flow = $('#reader-flow'), rsvp = $('#reader-rsvp');
  if (mode === 'flash') { flow.hidden = true; rsvp.hidden = false; $('#rsvp-guide').hidden = true; renderRsvp(); if (!R._flashWarned) { R._flashWarned = true; toast('フラッシュは拾い読み向け。速くしすぎ・光がつらい時は集中へ', 2600); } }
  else { rsvp.hidden = true; flow.hidden = false; renderFlow(); centerCurrent(false); }
  const hideCtrl = mode === 'free' ? 'hidden' : 'visible';
  $('#ctrl-play').style.visibility = hideCtrl; $('#ctrl-slow').style.visibility = hideCtrl; $('#ctrl-fast').style.visibility = hideCtrl;
  updateBar();
}

/* ---------- 集中/自由（全文） ---------- */
function renderFlow() {
  const flow = $('#reader-flow');
  const byBlock = {};
  R.units.forEach((u, i) => { (byBlock[u.bi] = byBlock[u.bi] || []).push(i); });
  let html = '';
  R.doc.blocks.forEach((b, bi) => {
    const uix = byBlock[bi] || [];
    if (b.type === 'heading') html += `<div class="blk-head h${Math.min(b.level, 3)}" data-u="${uix[0]}">${esc(b.text)}</div>`;
    else if (b.type === 'code' || b.type === 'table') html += `<pre class="blk-code" data-u="${uix[0]}">${esc(b.text)}</pre>`;
    else if (b.type === 'list') {
      html += '<ul class="blk-list">';
      const byItem = {};
      uix.forEach((i) => { const it = R.units[i].ii || 0; (byItem[it] = byItem[it] || []).push(i); });
      Object.keys(byItem).forEach((it) => { html += '<li class="blk-li">' + byItem[it].map(sentSpan).join('') + '</li>'; });
      html += '</ul>';
    } else {
      const tag = b.type === 'quote' ? 'div' : 'p'; const cls = b.type === 'quote' ? 'blk-quote' : 'para';
      html += `<${tag} class="${cls}">` + uix.map(sentSpan).join('') + `</${tag}>`;
    }
  });
  flow.innerHTML = html;
  paintFlowState();
}
function sentSpan(i) { return `<span class="sent" data-u="${i}">${inlineMd(R.units[i].text)}</span>`; }
function paintFlowState() {
  $$('#reader-flow [data-u]').forEach((el) => {
    const i = +el.dataset.u;
    el.classList.toggle('is-cur', i === R.cur);
    el.classList.toggle('is-read', i < R.cur);
    el.classList.toggle('is-marked', R.markedUnits.has(i));
  });
}
function centerCurrent(smooth = true) {
  const el = $(`#reader-flow [data-u="${R.cur}"]`);
  // 自動再生中は瞬間移動（スムーススクロールが連続して衝突するとカクつくため）
  if (el) el.scrollIntoView({ block: 'center', behavior: (smooth && !reduceMotion() && !R.playing) ? 'smooth' : 'auto' });
}

/* ---------- フラッシュ(RSVP) ---------- */
function renderRsvp() {
  const u = R.units[R.cur]; if (!u) return;
  const chunks = chunksOf(R.cur);
  R.curChunk = clamp(R.curChunk, 0, Math.max(0, chunks.length - 1));
  // 中央固定・横揺れなし（チャンクごとのreflow計測もしない＝高速でも滑らか）
  $('#rsvp-chunk').textContent = chunks[R.curChunk] || '';
  $('#rsvp-sentence').textContent = u.plain || u.text;
  updateBar();
}

function updateBar() {
  const p = R.paceable.length ? (paceIndexOf(R.cur) + 1) / R.paceable.length : 0;
  $('#reader-bar').style.width = (clamp(p, 0, 1) * 100) + '%';
  const u = R.units[R.cur];
  $('#reader-crumb').textContent = u && u.hp && u.hp.length ? u.hp.join(' › ') : (R.doc ? R.doc.title : '');
}

/* ---------- タイミング ---------- */
function dwellMs(unitIdx, chunkText) {
  const u = R.units[unitIdx];
  const text = chunkText != null ? chunkText : u.plain;
  const chars = [...text].length || 1;
  let ms = (chars / settings.cpm) * 60000;
  // 息継ぎは速度比例の小さな伸び（固定の大ポーズはガクつくので使わない）
  const last = text.slice(-1);
  if (/[。．！？!?…]/.test(last)) ms += Math.min(ms * 0.6, 200);
  else if (/[、，]/.test(last)) ms += Math.min(ms * 0.3, 80);
  if ((chunkText == null || isLastChunk(unitIdx)) && u.role === 'head') ms += 180;
  const minMs = R.mode === 'flash' ? 85 : 130;
  return clamp(ms, minMs, 1400);
}
function isLastChunk(u) { return R.mode !== 'flash' || R.curChunk >= chunksOf(u).length - 1; }
function currentDwell() { return R.mode === 'flash' ? dwellMs(R.cur, chunksOf(R.cur)[R.curChunk]) : dwellMs(R.cur, null); }

/* ---------- 再生 ---------- */
function play() {
  if (R.mode === 'free' || R.playing) return;
  if (R.mode === 'flash' && reduceMotion()) { toast('「動きを減らす」設定中はフラッシュ自動再生は無効。▶◀で手動送り'); return; }
  R.playing = true;
  const b = $('#ctrl-play'); b.textContent = '❚❚'; b.classList.add('is-playing');
  R.deadline = performance.now() + currentDwell();
  R.raf = requestAnimationFrame(loop);
}
function pause() {
  R.playing = false; cancelAnimationFrame(R.raf);
  const b = $('#ctrl-play'); if (b) { b.textContent = '▶'; b.classList.remove('is-playing'); }
}
function togglePlay() { R.playing ? pause() : play(); }
function loop(t) {
  if (!R.playing) return;
  if (t >= R.deadline) {
    const moved = stepForward(true);
    if (!moved) { pause(); toast('最後まで来た'); return; }
    if (R._recallPending) return;     // 想起プロンプト表示中は停止
    R.deadline = t + currentDwell();
  }
  R.raf = requestAnimationFrame(loop);
}

/* ---------- 移動 ---------- */
function stepForward(auto) {
  if (R.mode === 'free') return false;
  if (R.mode === 'flash') {
    const cs = chunksOf(R.cur);
    if (R.curChunk < cs.length - 1) { R.curChunk++; renderRsvp(); return true; }
    const n = nextPace(R.cur); if (n < 0) return false;
    if (auto && maybeRecall(n)) return true;
    R.cur = n; R.curChunk = 0; renderRsvp(); saveProgress(); return true;
  }
  const n = nextPace(R.cur); if (n < 0) return false;
  if (auto && maybeRecall(n)) return true;
  R.cur = n; setCurUi(); return true;
}
function stepBack() {
  if (R.mode === 'flash' && R.curChunk > 0) { R.curChunk--; renderRsvp(); return; }
  const p = prevPace(R.cur); if (p < 0) return;
  R.cur = p; R.curChunk = 0;
  if (R.mode === 'flash') renderRsvp(); else setCurUi();
  saveProgress();
}
function setCur(i) {
  if (i < 0 || i >= R.units.length || !R.units[i].paceable) return;
  R.cur = i; R.curChunk = 0;
  if (R.mode === 'flash') renderRsvp(); else setCurUi();
  saveProgress();
}
function setCurUi() { paintFlowState(); centerCurrent(true); updateBar(); }

/* ---------- 想起プロンプト ---------- */
function maybeRecall(nextIdx) {
  if (!settings.recall) return false;
  const cur = R.units[R.cur], nx = R.units[nextIdx];
  if (nx.role === 'head' && (nx.level || 1) <= 2 && cur.role !== 'head') {
    const pace = paceIndexOf(R.cur);
    if (pace - (R._lastRecallPace == null ? -999 : R._lastRecallPace) < 15) return false; // 区切り過密なら飛ばす
    R._lastRecallPace = pace;
    R._wasPlaying = R.playing; pause(); R._recallPending = true;
    const title = (cur.hp && cur.hp.length) ? cur.hp[cur.hp.length - 1] : R.doc.title;
    $('#recall-q').textContent = `「${title}」— ここまでで押さえたいことは？`;
    $('#recall-input').value = '';
    $('#recall').dataset.hp = JSON.stringify(cur.hp || []);
    $('#recall').dataset.next = nextIdx;
    $('#recall').hidden = false;
    return true;
  }
  return false;
}
async function recallDone(save) {
  const r = $('#recall'); r.hidden = true;
  const nextIdx = +r.dataset.next;
  if (save) {
    const txt = $('#recall-input').value.trim();
    if (txt) {
      try {
        await DB.put('marks', { id: uid(), docId: R.doc.id, type: 'recall', unitIndex: -1, headingPath: JSON.parse(r.dataset.hp || '[]'), sentence: txt, paragraph: '', before: '', after: '', note: '', tags: ['まとめ'], createdAt: now(), cpm: settings.cpm, srs: { box: 0, due: now() + DAY } });
        refreshBadge();
      } catch (e) { toast('保存に失敗'); }
    }
  }
  R._recallPending = false;
  R.cur = nextIdx; R.curChunk = 0;
  if (R.mode === 'flash') renderRsvp(); else setCurUi();
  saveProgress();
  if (R._wasPlaying) { R._wasPlaying = false; play(); }
}

/* ---------- 捕獲（点ではなく「直前に読んだ帯」を掴む） ---------- */
function captureWindow(focalIdx) {
  const w = settings.markWidth || 1;
  // 速度に連動: だいたい直前1.8秒ぶん ≒ round(cpm/1000) 文 さかのぼる（反応ラグ吸収）
  const back = clamp(Math.round((settings.cpm / 1000) * w), 1, 8);
  const fwd = w >= 2 ? 2 : 1;
  let start = focalIdx, end = focalIdx, k, n;
  k = focalIdx; n = back; while (n > 0) { const p = prevPace(k); if (p < 0 || R.units[p].role === 'head') break; start = p; k = p; n--; }
  k = focalIdx; n = fwd; while (n > 0) { const q = nextPace(k); if (q < 0 || R.units[q].role === 'head') break; end = q; k = q; n--; }
  return { start, end };
}
async function captureUnit(i, openEdit) {
  const u = R.units[i]; if (!u) return;
  let span = { start: i, end: i };
  if (u.role !== 'head') span = captureWindow(i);
  const idxs = [];
  for (let k = span.start; k <= span.end; k++) if (R.units[k] && R.units[k].paceable) idxs.push(k);
  if (!idxs.length) idxs.push(i);
  const region = idxs.map((k) => R.units[k].plain).join('');
  const mark = {
    id: uid(), docId: R.doc.id, type: 'mark', unitIndex: i, blockIndex: u.bi,
    sourceTitle: R.doc.title, headingPath: u.hp || [],
    sentence: region, focal: u.plain, paragraph: stripMd(u.blockText || u.text),
    span, note: '', tags: [], createdAt: now(), cpm: settings.cpm, srs: { box: 0, due: now() + DAY },
  };
  try { await DB.put('marks', mark); } catch (e) { toast('保存に失敗'); return; }
  idxs.forEach((k) => R.markedUnits.add(k));
  if (R.mode !== 'flash') idxs.forEach((k) => { const el = $(`#reader-flow [data-u="${k}"]`); if (el) el.classList.add('is-marked'); });
  requestPersist(); refreshBadge(); flashMarkBtn();
  if (openEdit) openMarkEdit(mark.id); else toast(`栞：${idxs.length}文ぶん保存`);
}
function flashMarkBtn() { const b = $('#ctrl-mark'); b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 320); }

/* =========================================================
   本棚
   ========================================================= */
async function renderLibrary() {
  const docs = (await DB.all('docs')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const allMarks = await DB.all('marks');
  const markCount = {}; allMarks.forEach((m) => { markCount[m.docId] = (markCount[m.docId] || 0) + 1; });
  const wrap = $('#library-list');
  if (!docs.length) { wrap.innerHTML = `<div class="empty">まだ何もない。<br>右上の「＋ 取り込む」から<br>md か txt を入れてみて。<br><br>本文を貼り付けてもいい。</div>`; return; }
  wrap.innerHTML = docs.map((d) => `<button class="doc" data-doc="${d.id}">
      <div class="doc__title">${esc(d.title)}</div>
      <div class="doc__meta"><span>${d.sentCount || 0} 文</span><span>栞 ${markCount[d.id] || 0}</span><span>${(d.type || 'md').toUpperCase()}</span><span class="doc__del" data-del="${d.id}">削除</span></div>
      <div class="doc__prog"><i style="width:${Math.round((d.progress || 0) * 100)}%"></i></div>
    </button>`).join('');
}
async function deleteDoc(id) {
  const doc = await DB.get('docs', id);
  const ms = await DB.byIndex('marks', 'docId', id);
  for (const m of ms) { m.sourceTitle = doc ? doc.title : '(削除済み)'; m.orphan = true; try { await DB.put('marks', m); } catch (e) {} }
  await DB.del('docs', id);
  renderLibrary();
  if (ms.length) toast(`本を削除（栞 ${ms.length} 件は出典付きで保持）`);
}

/* =========================================================
   栞 一覧 + 編集 + 抽出
   ========================================================= */
let marksFilter = { doc: 'all', tag: 'all' };
function titleOf(m, dt) { return dt[m.docId] || m.sourceTitle || '出典なし'; }
function withFocal(region, focal) {
  region = region || ''; focal = focal || '';
  if (focal && region.includes(focal) && focal !== region) {
    const i = region.indexOf(focal);
    return esc(region.slice(0, i)) + '<mark class="fc">' + esc(focal) + '</mark>' + esc(region.slice(i + focal.length));
  }
  return esc(region);
}
async function renderMarks() {
  const marks = (await DB.all('marks')).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const docs = await DB.all('docs'); const dt = {}; docs.forEach((d) => dt[d.id] = d.title);
  const tags = new Set(); marks.forEach((m) => (m.tags || []).forEach((t) => tags.add(t)));
  let fh = `<button class="${marksFilter.doc === 'all' && marksFilter.tag === 'all' ? 'is-on' : ''}" data-f="all">すべて (${marks.length})</button>`;
  docs.forEach((d) => { fh += `<button class="${marksFilter.doc === d.id ? 'is-on' : ''}" data-fdoc="${d.id}">${esc(d.title)}</button>`; });
  Array.from(tags).forEach((t) => { fh += `<button class="${marksFilter.tag === t ? 'is-on' : ''}" data-ftag="${esc(t)}">#${esc(t)}</button>`; });
  $('#marks-filter').innerHTML = fh;
  let list = marks;
  if (marksFilter.doc !== 'all') list = list.filter((m) => m.docId === marksFilter.doc);
  if (marksFilter.tag !== 'all') list = list.filter((m) => (m.tags || []).includes(marksFilter.tag));
  const wrap = $('#marks-list');
  if (!list.length) { wrap.innerHTML = `<div class="empty">栞はまだない。<br>本を読んで ❏栞 を押すと、<br>その文が前後ごとここに残る。</div>`; return; }
  wrap.innerHTML = list.map((m) => {
    const crumb = [titleOf(m, dt)].concat(m.headingPath || []).join(' › ');
    return `<div class="mark" data-mark="${m.id}">
      <div class="mark__crumb">${m.type === 'recall' ? '✎ まとめ · ' : ''}${m.orphan ? '※ ' : ''}${esc(crumb)}</div>
      <div class="mark__text">${withFocal(m.sentence, m.focal)}</div>
      ${m.note ? `<div class="mark__note">✎ ${esc(m.note)}</div>` : ''}
      ${(m.tags || []).length ? `<div class="mark__tags">${m.tags.map((t) => `<span class="tagchip">#${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="mark__foot"><small>${new Date(m.createdAt).toLocaleDateString('ja-JP')}</small><button class="mark__open" data-edit="${m.id}">編集</button></div>
    </div>`;
  }).join('');
}
/* 範囲エディタ */
let editCtx = null;
function sectionBounds(units, idx) {
  let lo = idx, hi = idx;
  for (let k = idx - 1; k >= 0; k--) { if (units[k].role === 'head') break; if (units[k].paceable) lo = k; }
  for (let k = idx + 1; k < units.length; k++) { if (units[k].role === 'head') break; if (units[k].paceable) hi = k; }
  return { lo, hi };
}
function rangeRegion(units, start, end) {
  const a = []; for (let k = start; k <= end; k++) if (units[k] && units[k].paceable) a.push(units[k].plain); return a.join('');
}
function renderRangeEditor() {
  const c = editCtx; if (!c) return;
  let html = '';
  for (let k = c.lo; k <= c.hi; k++) {
    const u = c.units[k]; if (!u || !u.paceable) continue;
    html += `<div class="rs ${k >= c.start && k <= c.end ? 'on' : ''} ${k === c.focal ? 'fc' : ''}" data-k="${k}">${esc(u.plain)}</div>`;
  }
  $('#markedit-range').innerHTML = html;
}
async function openMarkEdit(id) {
  const m = await DB.get('marks', id); if (!m) return;
  $('#mark-sheet').hidden = false; $('#mark-sheet').dataset.id = id;
  $('#markedit-crumb').textContent = (m.headingPath || []).join(' › ');
  $('#markedit-note').value = m.note || '';
  $('#markedit-tags').value = (m.tags || []).join(' ');
  editCtx = null;
  let canEdit = false;
  if (m.span && m.docId && m.type !== 'recall') {
    const doc = await DB.get('docs', m.docId);
    if (doc && doc.blocks) {
      const units = buildUnits(doc.blocks);
      if (units[m.span.start] && units[m.span.end]) {
        const anchor = (typeof m.unitIndex === 'number' && m.unitIndex >= 0 && units[m.unitIndex]) ? m.unitIndex : m.span.start;
        const b = sectionBounds(units, anchor);
        editCtx = { units, lo: b.lo, hi: b.hi, start: clamp(m.span.start, b.lo, b.hi), end: clamp(m.span.end, b.lo, b.hi), focal: m.unitIndex };
        canEdit = true; renderRangeEditor();
      }
    }
  }
  $('#markedit-hint').hidden = !canEdit;
  $('#markedit-span-ctrl').hidden = !canEdit;
  if (!canEdit) {
    if (m.focal) $('#markedit-range').innerHTML = withFocal(m.sentence, m.focal);
    else $('#markedit-range').innerHTML = `<span class="ctx">${esc(m.before || '')}</span><span class="hl">${esc(m.sentence)}</span><span class="ctx">${esc(m.after || '')}</span>`;
  }
}
async function saveMarkEdit() {
  const id = $('#mark-sheet').dataset.id; const m = await DB.get('marks', id); if (!m) return;
  m.note = $('#markedit-note').value.trim();
  m.tags = $('#markedit-tags').value.split(/\s+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
  if (editCtx) { m.span = { start: editCtx.start, end: editCtx.end }; m.sentence = rangeRegion(editCtx.units, editCtx.start, editCtx.end); }
  try { await DB.put('marks', m); } catch (e) {}
  $('#mark-sheet').hidden = true; editCtx = null; renderMarks();
  if (!$('#reader').hidden && R.doc && R.doc.id === m.docId) await refreshMarkedUnits();
}
async function deleteMarkEdit() {
  const id = $('#mark-sheet').dataset.id; const m = await DB.get('marks', id);
  await DB.del('marks', id); editCtx = null;
  $('#mark-sheet').hidden = true; renderMarks(); refreshBadge();
  if (m && !$('#reader').hidden && R.doc && R.doc.id === m.docId) await refreshMarkedUnits();
}
async function refreshMarkedUnits() {
  const marks = await DB.byIndex('marks', 'docId', R.doc.id);
  R.markedUnits = new Set();
  marks.filter((m) => m.type !== 'recall').forEach((m) => {
    if (m.span && typeof m.span.start === 'number') { for (let k = m.span.start; k <= m.span.end; k++) R.markedUnits.add(k); }
    else if (typeof m.unitIndex === 'number' && m.unitIndex >= 0) R.markedUnits.add(m.unitIndex);
  });
  if (R.mode !== 'flash') paintFlowState();
}

/* ---------- 抽出 ---------- */
async function buildExport(fmt, opts = {}) {
  let marks = (await DB.all('marks')).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!opts.ignoreFilter) {
    if (marksFilter.doc !== 'all') marks = marks.filter((m) => m.docId === marksFilter.doc);
    if (marksFilter.tag !== 'all') marks = marks.filter((m) => (m.tags || []).includes(marksFilter.tag));
  }
  const docs = await DB.all('docs'); const dt = {}; docs.forEach((d) => dt[d.id] = d.title);
  if (fmt === 'anki') return marks.map((m) => `${((m.headingPath || []).join(' › ') || titleOf(m, dt)) + (m.note ? ' / ' + m.note : '')}\t${m.sentence}`.replace(/\t(.*)$/, (x, b) => '\t' + b.replace(/\t/g, ' '))).join('\n');
  if (fmt === 'txt') return marks.map((m) => `[${[titleOf(m, dt)].concat(m.headingPath || []).join(' / ')}]\n${m.sentence}${m.note ? '\nメモ：' + m.note : ''}`).join('\n\n');
  const byDoc = {}; marks.forEach((m) => { (byDoc[m.docId] = byDoc[m.docId] || []).push(m); });
  let out = `# 脳栞 抽出\n生成: ${new Date().toLocaleString('ja-JP')}\n`;
  Object.keys(byDoc).forEach((did) => {
    out += `\n## ${titleOf(byDoc[did][0], dt)}\n`;
    let lastHp = '';
    byDoc[did].forEach((m) => {
      const hp = (m.headingPath || []).join(' › ');
      if (hp && hp !== lastHp) { out += `\n### ${hp}\n`; lastHp = hp; }
      out += `\n> ${m.sentence}\n`;
      if (m.focal && m.focal !== m.sentence) out += `\n中心：${m.focal}\n`;
      if (m.note) out += `\nメモ：${m.note}\n`;
      if ((m.tags || []).length) out += `\nタグ：${m.tags.map((t) => '#' + t).join(' ')}\n`;
    });
  });
  return out;
}
async function doExport(opts = {}) {
  const ig = !!opts.all;
  const choice = await pickExport();
  if (!choice) return;
  const md = await buildExport('md', { ignoreFilter: ig });
  if (choice === 'copy') { await copyText(md); return; }
  let data = md, mime = 'text/markdown', ext = 'md';
  if (choice === 'txt') { data = await buildExport('txt', { ignoreFilter: ig }); mime = 'text/plain'; ext = 'txt'; }
  if (choice === 'anki') { data = await buildExport('anki', { ignoreFilter: ig }); mime = 'text/plain'; ext = 'tsv'; }
  await saveOrShare(data, mime, `noushiori_${Date.now()}.${ext}`, choice === 'share');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('コピーした'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove(); toast(ok ? 'コピーした' : 'コピー失敗。手動で選択して');
  }
}
async function saveOrShare(data, mime, name, preferShare) {
  try {
    const file = new File([data], name, { type: mime });
    if ((preferShare || true) && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: '脳栞 抽出' }); return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try {
    const blob = new Blob([data], { type: mime }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('書き出した');
  } catch (e) { await copyText(typeof data === 'string' ? data : ''); }
}
function pickExport() {
  return new Promise((res) => {
    const acts = [['copy', 'コピー'], ['share', '共有 / 保存（他アプリへ）'], ['md', 'mdで保存'], ['txt', 'txtで保存'], ['anki', 'Anki(TSV)で保存']];
    const sheet = document.createElement('div'); sheet.className = 'sheet';
    sheet.innerHTML = `<div class="sheet__panel"><div class="sheet__handle"></div><h2 class="sheet__title">抽出する</h2>${acts.map((a) => `<button class="bigbtn" data-x="${a[0]}" style="margin-top:8px">${a[1]}</button>`).join('')}<button class="btn btn--ghost" data-x="" style="margin-top:14px;width:100%">やめる</button></div>`;
    document.body.appendChild(sheet);
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) { sheet.remove(); return res(null); }
      const b = e.target.closest('[data-x]'); if (!b) return;
      const v = b.dataset.x; sheet.remove(); res(v || null);
    });
  });
}

/* ---------- バックアップ ---------- */
async function exportBackup() {
  const docs = await DB.all('docs'); const marks = await DB.all('marks');
  const json = JSON.stringify({ app: 'noushiori', version: 1, exportedAt: now(), settings, docs, marks }, null, 0);
  await saveOrShare(json, 'application/json', `noushiori_backup_${Date.now()}.json`, true);
}
async function importBackup(file) {
  try {
    const text = await file.text(); const data = JSON.parse(text);
    if (!data || data.app !== 'noushiori') { toast('脳栞のバックアップではない'); return; }
    let nd = 0, nm = 0;
    for (const d of (data.docs || [])) { await DB.put('docs', d); nd++; }
    for (const m of (data.marks || [])) { await DB.put('marks', m); nm++; }
    if (data.settings) { settings = { ...DEFAULTS, ...data.settings }; applySettings(); saveSettings(); }
    toast(`復元：本${nd}・栞${nm}`); renderLibrary(); refreshBadge();
  } catch (e) { toast('復元に失敗（ファイルを確認）'); }
}

/* =========================================================
   想起（Leitner）
   ========================================================= */
const BOX_DAYS = [0, 1, 3, 7, 16, 35];
let reviewQueue = [];
async function refreshBadge() {
  const due = (await DB.all('marks')).filter((m) => m.srs && m.srs.due <= now()).length;
  const badge = $('#tab-badge');
  if (due > 0) { badge.hidden = false; badge.textContent = due > 99 ? '99+' : due; } else badge.hidden = true;
}
async function renderReview() {
  const marks = await DB.all('marks');
  reviewQueue = marks.filter((m) => m.srs && m.srs.due <= now()).sort((a, b) => a.srs.due - b.srs.due);
  const upcoming = marks.filter((m) => m.srs && m.srs.due > now()).length;
  $('#review-count').textContent = `${reviewQueue.length} 件`;
  const area = $('#review-area');
  if (!reviewQueue.length) { area.innerHTML = `<div class="empty">今日の想起は完了。<br>${upcoming ? `次の予定：${upcoming} 件` : '栞を増やすとここで復習できる。'}</div>`; return; }
  showReviewCard();
}
async function showReviewCard() {
  const m = reviewQueue[0]; if (!m) { renderReview(); return; }
  const docs = await DB.all('docs'); const dt = {}; docs.forEach((d) => dt[d.id] = d.title);
  const crumb = [titleOf(m, dt)].concat(m.headingPath || []).join(' › ');
  const cue = m.type === 'recall' ? `「${(m.headingPath || []).slice(-1)[0] || titleOf(m, dt)}」の要点は？` : (m.note ? m.note : 'この箇所には何が書いてあった？');
  $('#review-area').innerHTML = `<div class="rev-card">
    <div class="rev-card__crumb">${esc(crumb)} · 残り${reviewQueue.length}</div>
    <div class="rev-card__cue">${esc(cue)}</div>
    <div class="rev-card__ans" id="rev-ans" hidden>${esc(m.sentence)}</div>
    <div class="rev-btns" id="rev-btns"><button class="btn" id="rev-show">答えを見る</button></div>
  </div>`;
  $('#rev-show').onclick = () => {
    $('#rev-ans').hidden = false;
    $('#rev-btns').innerHTML = `<button class="btn btn--ghost" id="rev-again">曖昧</button><button class="btn" id="rev-ok">思い出せた</button>`;
    $('#rev-again').onclick = () => gradeCard(false);
    $('#rev-ok').onclick = () => gradeCard(true);
  };
}
async function gradeCard(ok) {
  const m = reviewQueue.shift();
  if (m) {
    if (ok) { m.srs.box = Math.min((m.srs.box || 0) + 1, BOX_DAYS.length - 1); m.srs.due = now() + BOX_DAYS[m.srs.box] * DAY; }
    else { m.srs.box = 0; m.srs.due = now() + 20 * 60000; }   // 曖昧→20分後（当日キューからは抜ける）
    m.srs.last = now();
    try { await DB.put('marks', m); } catch (e) {}
  }
  refreshBadge();
  reviewQueue.length ? showReviewCard() : renderReview();
}

/* =========================================================
   取り込み
   ========================================================= */
async function importText(title, raw, type) {
  raw = String(raw || '');
  if (!raw.trim()) { toast('中身が空'); return; }
  if (raw.length > 2000000) { toast('ファイルが大きすぎる（2MB上限）'); return; }
  const blocks = parseDoc(raw, type);
  const units = buildUnits(blocks);
  const doc = {
    id: uid(), title: (title || guessTitle(blocks, raw)).slice(0, 60), type, blocks, pos: 0, progress: 0,
    paceCount: units.filter((u) => u.paceable).length, sentCount: units.filter((u) => u.paceable && u.role !== 'head').length,
    createdAt: now(), updatedAt: now(),
  };
  try { await DB.put('docs', doc); } catch (e) { toast('保存に失敗'); return; }
  requestPersist();
  $('#import-sheet').hidden = true; $('#paste-title').value = ''; $('#paste-body').value = '';
  await renderLibrary(); openReader(doc.id);
}
function guessTitle(blocks, raw) {
  const h = blocks.find((b) => b.type === 'heading'); if (h) return h.text.slice(0, 40);
  const p = blocks.find((b) => b.type === 'para');
  return ((p ? p.text : raw).trim().slice(0, 24) || '無題') + '…';
}

/* =========================================================
   設定UI
   ========================================================= */
function renderSettings() {
  $('#settings-area').innerHTML = `<div class="set">
    <div class="set-row"><label>文字サイズ <b id="s-size">${settings.readSize}px</b></label><input type="range" id="s-readsize" min="17" max="30" step="1" value="${settings.readSize}"></div>
    <div class="set-row"><label>読書速度 <b id="s-cpmv">${settings.cpm}</b> 文字/分</label><input type="range" id="s-cpm" min="250" max="3500" step="50" value="${settings.cpm}"></div>
    <div class="set-row"><label>書体</label><div class="seg" id="s-serif"><button data-v="0" class="${!settings.serif ? 'on' : ''}">ゴシック</button><button data-v="1" class="${settings.serif ? 'on' : ''}">明朝</button></div></div>
    <div class="set-row"><label>既定モード</label><div class="seg" id="s-mode"><button data-v="focus" class="${settings.defaultMode === 'focus' ? 'on' : ''}">集中</button><button data-v="flash" class="${settings.defaultMode === 'flash' ? 'on' : ''}">フラッシュ</button><button data-v="free" class="${settings.defaultMode === 'free' ? 'on' : ''}">自由</button></div></div>
    <div class="set-row"><label>栞の範囲（押した周辺をどれだけ拾うか）</label><div class="seg" id="s-markw"><button data-v="0.5" class="${settings.markWidth === 0.5 ? 'on' : ''}">せまい</button><button data-v="1" class="${(settings.markWidth || 1) === 1 ? 'on' : ''}">標準</button><button data-v="2" class="${settings.markWidth === 2 ? 'on' : ''}">ひろい</button></div></div>
    <div class="set-row toggle"><label>見出しで想起プロンプト</label><input type="checkbox" id="s-recall" ${settings.recall ? 'checked' : ''}></div>
    <div class="set-row toggle"><label>読書中に画面を眠らせない</label><input type="checkbox" id="s-wake" ${settings.wakelock ? 'checked' : ''}></div>
    <div class="set-row toggle"><label>高コントラスト（薄字を減らす）</label><input type="checkbox" id="s-nofade" ${settings.noFade ? 'checked' : ''}></div>
    <div class="set-row"><label>テーマ</label><div class="seg" id="s-theme"><button data-v="auto" class="${settings.theme === 'auto' ? 'on' : ''}">自動</button><button data-v="dark" class="${settings.theme === 'dark' ? 'on' : ''}">ダーク</button><button data-v="light" class="${settings.theme === 'light' ? 'on' : ''}">ライト</button></div></div>
    <div class="set-row"><button class="btn btn--ghost" id="s-hint">使い方をもう一度見る</button></div>
    <div class="set-row"><button class="btn btn--ghost" id="s-export">栞をぜんぶ書き出す</button></div>
    <div class="set-row"><button class="btn btn--ghost" id="s-backup">バックアップ（全データ）を書き出す</button></div>
    <div class="set-row"><label class="bigbtn" for="restore-input" style="margin:0">バックアップから復元</label><input type="file" id="restore-input" accept="application/json,.json" hidden></div>
    <div class="set-foot">脳栞 · この端末内のみに保存${DB.memMode() ? '（※今はメモリのみ＝再読込で消える）' : ''}<br>大事な栞は時々バックアップを書き出して · v1</div>
  </div>`;
  $('#s-readsize').oninput = (e) => { settings.readSize = +e.target.value; $('#s-size').textContent = settings.readSize + 'px'; applySettings(); saveSettings(); };
  $('#s-cpm').oninput = (e) => { settings.cpm = +e.target.value; $('#s-cpmv').textContent = settings.cpm; saveSettings(); };
  $('#s-serif').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.serif = b.dataset.v === '1'; saveSettings(); renderSettings(); };
  $('#s-mode').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.defaultMode = b.dataset.v; saveSettings(); renderSettings(); };
  $('#s-theme').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.theme = b.dataset.v; applySettings(); saveSettings(); renderSettings(); };
  $('#s-markw').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.markWidth = parseFloat(b.dataset.v); saveSettings(); renderSettings(); };
  $('#s-recall').onchange = (e) => { settings.recall = e.target.checked; saveSettings(); };
  $('#s-wake').onchange = (e) => { settings.wakelock = e.target.checked; saveSettings(); };
  $('#s-nofade').onchange = (e) => { settings.noFade = e.target.checked; applySettings(); saveSettings(); };
  $('#s-hint').onclick = () => { $('#hint').hidden = false; };
  $('#s-export').onclick = () => doExport({ all: true });
  $('#s-backup').onclick = () => exportBackup();
  $('#restore-input').onchange = (e) => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; };
}

/* =========================================================
   Wake Lock / 可視性 / persist
   ========================================================= */
async function acquireWakeLock() {
  if (!settings.wakelock || !('wakeLock' in navigator)) return false;
  try { R.wakelock = await navigator.wakeLock.request('screen'); return true; } catch (e) { return false; }
}
function releaseWakeLock() { if (R.wakelock) { R.wakelock.release().catch(() => {}); R.wakelock = null; } }
async function requestPersist() { try { if (navigator.storage && navigator.storage.persist) { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } } catch (e) {} }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (R.playing) pause(); releaseWakeLock(); }
  else if (!$('#reader').hidden) acquireWakeLock();
});

/* =========================================================
   ルーター
   ========================================================= */
function go(screen) {
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.dataset.screen === screen));
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.go === screen));
  if (screen === 'library') renderLibrary();
  if (screen === 'marks') renderMarks();
  if (screen === 'review') renderReview();
  if (screen === 'settings') renderSettings();
}

/* =========================================================
   イベント結線
   ========================================================= */
function bind() {
  $('#tabbar').addEventListener('click', (e) => { const t = e.target.closest('[data-go]'); if (t) go(t.dataset.go); });

  $('#library-list').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); if (confirm('この本を削除する？（栞は出典付きで残ります）')) deleteDoc(del.dataset.del); return; }
    const d = e.target.closest('[data-doc]'); if (d) openReader(d.dataset.doc);
  });

  $('#btn-import').onclick = () => { $('#import-sheet').hidden = false; };
  $('#import-cancel').onclick = () => { $('#import-sheet').hidden = true; };
  $('#import-paste').onclick = () => importText($('#paste-title').value.trim(), $('#paste-body').value, 'md');
  $('#file-input').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    toast('読み込み中…');
    const rd = new FileReader();
    rd.onload = () => { const type = /\.(txt|text)$/i.test(f.name) ? 'txt' : 'md'; importText(f.name.replace(/\.[^.]+$/, ''), rd.result, type); };
    rd.onerror = () => toast('読み込みに失敗した');
    rd.readAsText(f);
    e.target.value = '';
  };

  $('#marks-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.f === 'all') marksFilter = { doc: 'all', tag: 'all' };
    else if (b.dataset.fdoc) marksFilter = { ...marksFilter, doc: marksFilter.doc === b.dataset.fdoc ? 'all' : b.dataset.fdoc };
    else if (b.dataset.ftag) marksFilter = { ...marksFilter, tag: marksFilter.tag === b.dataset.ftag ? 'all' : b.dataset.ftag };
    renderMarks();
  });
  $('#marks-list').addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) openMarkEdit(b.dataset.edit); });
  $('#btn-export-all').onclick = () => doExport();
  $('#markedit-save').onclick = saveMarkEdit;
  $('#markedit-del').onclick = deleteMarkEdit;
  $('#markedit-range').addEventListener('click', (e) => {
    if (!editCtx) return;
    const el = e.target.closest('[data-k]'); if (!el) return;
    const k = +el.dataset.k; const c = editCtx;
    if (k < c.start) c.start = k;
    else if (k > c.end) c.end = k;
    else if ((k - c.start) <= (c.end - k)) c.start = k; else c.end = k;
    renderRangeEditor();
  });
  $('#markedit-span-ctrl').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !editCtx) return;
    const c = editCtx;
    const prevP = (i) => { for (let k = i - 1; k >= c.lo; k--) if (c.units[k].paceable) return k; return i; };
    const nextP = (i) => { for (let k = i + 1; k <= c.hi; k++) if (c.units[k].paceable) return k; return i; };
    const a = b.dataset.act;
    if (a === 'su') c.start = prevP(c.start);
    else if (a === 'sd') { const n = nextP(c.start); if (n <= c.end) c.start = n; }
    else if (a === 'eu') { const p = prevP(c.end); if (p >= c.start) c.end = p; }
    else if (a === 'ed') c.end = nextP(c.end);
    renderRangeEditor();
  });

  $('#reader-close').onclick = closeReader;
  $('#reader-mode').onclick = () => { const order = ['focus', 'flash', 'free']; setMode(order[(order.indexOf(R.mode) + 1) % 3]); };
  $('#ctrl-play').onclick = togglePlay;
  $('#ctrl-fwd').onclick = () => { pause(); stepForward(false); };
  $('#ctrl-back').onclick = () => { pause(); stepBack(); };
  $('#ctrl-slow').onclick = () => changeCpm(-1);
  $('#ctrl-fast').onclick = () => changeCpm(1);
  $('#ctrl-mark').onclick = () => captureUnit(R.cur, false);

  bindFlowGestures();
  bindTapToggle($('#reader-rsvp'));

  $('#recall-save').onclick = () => recallDone(true);
  $('#recall-skip').onclick = () => recallDone(false);
  $('#hint-ok').onclick = () => { $('#hint').hidden = true; settings.seenHint = true; saveSettings(); };
}

function changeCpm(dir) {
  const step = settings.cpm < 800 ? 50 : settings.cpm < 1600 ? 100 : 200;
  settings.cpm = clamp(settings.cpm + dir * step, 250, 3500); saveSettings();
  const r = $('#reader-speed'); r.textContent = settings.cpm + ' 文字/分'; r.classList.add('show');
  clearTimeout(changeCpm._t); changeCpm._t = setTimeout(() => r.classList.remove('show'), 1100);
}

/* タップ/長押し/スクロール判別（時刻＋変位＋scrollTop） */
function bindFlowGestures() {
  const flow = $('#reader-flow');
  let lpTimer = 0, lpFired = false, sx = 0, sy = 0, st = 0, sTop = 0, downU = null;
  flow.addEventListener('pointerdown', (e) => {
    lpFired = false; sx = e.clientX; sy = e.clientY; st = performance.now(); sTop = flow.scrollTop;
    if (settings.wakelock && !R.wakelock) acquireWakeLock();
    const el = e.target.closest('[data-u]'); downU = el ? +el.dataset.u : null;
    if (downU != null) lpTimer = setTimeout(() => { lpFired = true; if (navigator.vibrate) navigator.vibrate(8); captureUnit(downU, true); }, 480);
  });
  flow.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - sx) > 16 || Math.abs(e.clientY - sy) > 16) clearTimeout(lpTimer); });
  flow.addEventListener('pointercancel', () => clearTimeout(lpTimer));
  flow.addEventListener('pointerup', (e) => {
    clearTimeout(lpTimer);
    if (lpFired) { e.preventDefault(); return; }
    const moved = Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12;
    const scrolled = Math.abs(flow.scrollTop - sTop) > 4;
    const longHold = performance.now() - st > 500;
    if (moved || scrolled || longHold) return;
    const el = e.target.closest('[data-u]');
    if (!el) { if (R.mode !== 'free') togglePlay(); return; }
    const i = +el.dataset.u; const u = R.units[i];
    if (!u.paceable) { captureUnit(i, false); return; }
    if (R.mode === 'free') return;
    if (i === R.cur) togglePlay(); else { pause(); setCur(i); }
  });
}
function bindTapToggle(elm) {
  let sx = 0, sy = 0, st = 0;
  elm.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; st = performance.now(); });
  elm.addEventListener('pointerup', (e) => {
    if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12 || performance.now() - st > 500) return;
    togglePlay();
  });
}

/* Service Worker */
if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });

/* 起動 */
(async function init() {
  try { await loadSettings(); }
  catch (e) { settings = { ...DEFAULTS }; applySettings(); toast('この端末では保存できない可能性（メモリのみ動作）', 3500); }
  bind();
  go('library');
  requestPersist();
  try { await refreshBadge(); } catch (e) {}
})();
