import * as pdfjsLib from './lib/pdf.min.mjs';
import { loadSettings, openSettings } from './settings.js';
import { createGeminiTranslator } from './gemini.js';
import { createDocumentTranslator } from './document-translator.js';
import { toRuns } from './math.js';
import { disableNativeZoom } from './native-zoom.js';
import { createCitationDialog } from './citation-ui.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const $ = (s) => document.querySelector(s);
const pagesEl = $('#pages');
const srcSel = $('#src');
const dstSel = $('#dst');
const viewSel = $('#view');
// file= 以降をPDFのURLとして読む。自動の切り替えでは元のURLがそのまま（エンコードなしで）付いてくるので、
// URLSearchParams だとPDFのURLに含まれる & や + が壊れる
const fileUrl = (() => {
  const m = /[?&]file=(.*)$/s.exec(location.search);
  if (!m) return null;
  return /^[a-z]+%3A/i.test(m[1]) ? decodeURIComponent(m[1]) : m[1]; // アイコンから開いたときはエンコード済み
})();
// 他のサイトに埋め込まれて使われないようにする（ビューアはWebから開ける資源として登録しているため）
if (window.top !== window) throw new Error('埋め込みでは表示できません');
const GAP = 12; // 左右ページの間隔（CSSの .row gap と合わせる）
const MAX_CANVAS_PIXELS = 2 ** 24; // 1枚のcanvasの上限（約1600万画素）。拡大しすぎてメモリを食わないように
const RENDER_QUALITY = 1.5; // 表示に必要な密度より細かく描いて、細字や斜線の粗さを抑える
const LOCAL_TRANSLATION_LOOKAHEAD = 15;
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const state = {
  pdf: null,
  rows: [],
  currentPage: 0,
  translator: null,
  engine: null, // 翻訳ボタンで明示的に選んだエンジン
  translationAbort: null,
  translationVersion: 0,
  enabled: false,
  queue: [],
  working: false,
  exporting: false,
  name: 'document.pdf',
  zoom: Number(localStorage.getItem('zoom')) || 1, // ユーザーが選んだ倍率
  fitMode: null, // width / height。手動の倍率変更で解除する
  fit: 2, // 片側だけ表示するときに画面幅に合わせる倍率（buildRows で計算）
  settings: await loadSettings(),
};
let pageNavigationFrame = null;
let citationDialog = null;

let statusTimer;
const setStatus = (t) => {
  clearTimeout(statusTimer);
  const status = $('#status');
  status.textContent = t;
  status.hidden = !t;
  const error = /失敗|エラー|未対応|できません|拒否|正しくありません|APIキーを入力|同じ言語/.test(t);
  status.classList.toggle('error', error);
  if (!error && /完了しました|翻訳済み|保存しました/.test(t)) {
    statusTimer = setTimeout(() => { status.hidden = true; }, 3000);
  }
};

// 古い翻訳の終了で、新しい翻訳のローディングを消さないよう世代ごとに管理する。
const translationActivities = new Set();
const repairingTranslators = new WeakSet();
function beginTranslation() {
  const activity = { version: state.translationVersion };
  translationActivities.add(activity);
  updateStartButton();
  return () => { translationActivities.delete(activity); updateStartButton(); };
}

function updateStartButton() {
  const busy = [...translationActivities].some((a) => a.version === state.translationVersion);
  for (const [engine, selector, label] of [
    ['chrome', '#startLocal', 'ローカルAI'], ['gemini', '#startGemini', 'Gemini'],
  ]) {
    const button = $(selector), active = busy && state.engine === engine;
    button.disabled = busy;
    button.classList.toggle('loading', active);
    button.setAttribute('aria-busy', String(active));
    button.textContent = active ? '翻訳中…' : label;
    button.setAttribute('aria-label', `${label}で${active ? '翻訳中' : '翻訳'}`);
  }
}

// ---------- 設定の保存 ----------
srcSel.value = localStorage.getItem('src') || 'en';
dstSel.value = localStorage.getItem('dst') || 'ja';
viewSel.value = localStorage.getItem('view') || 'both';

// ---------- 表示の切り替え（保存もこの表示に合わせる） ----------
function applyView() {
  const fitRow = state.fitMode ? currentFitRow() : null;
  document.body.dataset.view = viewSel.value;
  localStorage.setItem('view', viewSel.value);
  if (state.fitMode && fitRow) fitToViewport(state.fitMode, fitRow);
  else applyZoom();
}

// ---------- 拡大・縮小 ----------
// 表示上の倍率。片側表示のときは、空いた幅いっぱいまで大きくする
const viewZoom = () => state.zoom * (viewSel.value === 'both' ? 1 : state.fit);

function applyZoom() {
  const ratio = scrollY / Math.max(1, document.documentElement.scrollHeight);
  document.documentElement.style.setProperty('--zoom', viewZoom());
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  $('#fitWidth').setAttribute('aria-pressed', String(state.fitMode === 'width'));
  $('#fitHeight').setAttribute('aria-pressed', String(state.fitMode === 'height'));
  localStorage.setItem('zoom', state.zoom);
  scrollTo(0, ratio * document.documentElement.scrollHeight); // だいたい同じ場所を表示し続ける
  rerenderVisible();
  schedulePageNavigation();
}

function stepZoom(dir) {
  const next = dir > 0
    ? ZOOMS.find((z) => z > state.zoom + 1e-6)
    : ZOOMS.findLast((z) => z < state.zoom - 1e-6);
  if (next !== undefined) state.zoom = next;
  state.fitMode = null;
  applyZoom();
}

function currentFitRow() {
  if (!state.rows.length) return null;
  const top = $('header').getBoundingClientRect().bottom;
  const shownView = document.body.dataset.view || viewSel.value;
  // IntersectionObserverのvisibleは先読み領域を含むので、実際に画面内にあるページを選ぶ。
  return state.rows.find((r) => {
    const box = shownView === 'ja' ? r.right : r.left;
    return box.getBoundingClientRect().bottom > top + 1;
  }) || state.rows.at(-1);
}

function fitToViewport(mode, row = currentFitRow(), align = true) {
  if (!row) return;
  const cs = getComputedStyle(pagesEl);
  const padding = (name) => parseFloat(cs[name]) || 0;
  const headerHeight = $('header').getBoundingClientRect().height;
  const width = pagesEl.clientWidth - padding('paddingLeft') - padding('paddingRight');
  const height = document.documentElement.clientHeight - headerHeight - 2 * padding('paddingTop');
  const columns = viewSel.value === 'both' ? 2 : 1;
  const displayScale = mode === 'width'
    ? width / (row.vp.width * columns + GAP * (columns - 1))
    : height / row.vp.height;
  const zoom = displayScale / (columns === 2 ? 1 : state.fit);
  if (!Number.isFinite(zoom) || zoom <= 0) return;
  const changed = state.fitMode !== mode || Math.abs(state.zoom - zoom) > 1e-6;
  state.fitMode = mode;
  state.zoom = zoom;
  if (!align && !changed) return; // ResizeObserverで同じ倍率を繰り返し適用しない
  applyZoom();
  if (align) {
    const box = viewSel.value === 'ja' ? row.right : row.left;
    scrollTo(0, Math.max(0, scrollY + box.getBoundingClientRect().top - headerHeight - padding('paddingTop')));
  }
}

$('#zoomIn').onclick = () => stepZoom(+1);
$('#zoomOut').onclick = () => stepZoom(-1);
$('#zoomReset').onclick = () => { state.fitMode = null; state.zoom = 1; applyZoom(); };
$('#fitWidth').onclick = () => fitToViewport('width');
$('#fitHeight').onclick = () => fitToViewport('height');

function handleZoomKey(e) {
  if (!state.pdf || e.defaultPrevented || e.altKey || (!e.ctrlKey && !e.metaKey)) return;
  const key = e.key;
  if (!['+', '=', '-', '0'].includes(key)) return;
  e.preventDefault();
  if (e.target?.closest?.('dialog[open]')) return;
  if (key === '0') $('#zoomReset').onclick();
  else stepZoom(key === '-' ? -1 : 1);
}

let wheelZoom = 0, wheelZoomFrame = null;
window.addEventListener('wheel', (e) => {
  if (!state.pdf || (!e.ctrlKey && !e.metaKey)) return;
  e.preventDefault();
  if (e.target?.closest?.('dialog[open]') || !e.deltaY) return;
  wheelZoom += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? document.documentElement.clientHeight : 1);
  if (wheelZoomFrame !== null) return;
  wheelZoomFrame = requestAnimationFrame(() => {
    wheelZoomFrame = null;
    state.zoom = Math.min(5, Math.max(0.1, state.zoom * Math.exp(-wheelZoom * 0.002)));
    wheelZoom = 0;
    state.fitMode = null;
    applyZoom();
  });
}, { passive: false });

const refit = () => {
  // 横スクロールから独立した固定ヘッダーの分だけ、PDF上端に余白を確保する。
  const height = $('header').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--toolbar-height', `${height}px`);
  if (state.fitMode) fitToViewport(state.fitMode, currentFitRow(), false);
  schedulePageNavigation();
  citationDialog?.position();
};
window.addEventListener('resize', refit);
// ツールバーが折り返した場合も、ページに使える高さを更新する。
const headerResize = new ResizeObserver(refit);
headerResize.observe($('header'));

// ---------- ページ移動 ----------
function updatePageNavigation(page = state.currentPage) {
  const total = state.pdf?.numPages || state.rows.length;
  const ready = total > 0 && state.rows.length === total;
  state.currentPage = total ? Math.max(1, Math.min(total, page || 1)) : 0;
  const input = $('#pageNumber');
  if (document.activeElement !== input) input.value = state.currentPage ? String(state.currentPage) : '';
  input.disabled = !ready;
  input.style.width = `${Math.max(2, String(total).length) + 2}ch`;
  $('#pageTotal').textContent = String(total);
  $('#prevPage').disabled = !ready || state.currentPage <= 1;
  $('#nextPage').disabled = !ready || state.currentPage >= total;
}

function schedulePageNavigation() {
  if (!state.rows.length) { updatePageNavigation(); return; }
  if (pageNavigationFrame !== null) return;
  pageNavigationFrame = requestAnimationFrame(() => {
    pageNavigationFrame = null;
    const top = $('header').getBoundingClientRect().bottom;
    const bottom = document.documentElement.clientHeight;
    const shownView = document.body.dataset.view || viewSel.value;
    let current = null, visibleHeight = 0;
    for (const r of state.rows) {
      const box = shownView === 'ja' ? r.right : r.left;
      const rect = box.getBoundingClientRect();
      const height = Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top));
      if (height > visibleHeight) { current = r; visibleHeight = height; }
    }
    updatePageNavigation((current || currentFitRow())?.index);
  });
}

function goToPage(page) {
  if (!state.rows.length || !Number.isSafeInteger(page)) return false;
  const index = Math.max(1, Math.min(state.rows.length, page));
  const row = state.rows[index - 1];
  if (state.fitMode) fitToViewport(state.fitMode, row);
  else {
    const box = viewSel.value === 'ja' ? row.right : row.left;
    const padding = parseFloat(getComputedStyle(pagesEl).paddingTop) || 0;
    scrollTo(0, Math.max(0, scrollY + box.getBoundingClientRect().top - $('header').getBoundingClientRect().bottom - padding));
  }
  updatePageNavigation(index);
  return true;
}

$('#prevPage').onclick = () => goToPage(state.currentPage - 1);
$('#nextPage').onclick = () => goToPage(state.currentPage + 1);
$('#pageNumber').onfocus = () => $('#pageNumber').select();
$('#pageNumber').onblur = () => updatePageNavigation();
$('#pageNumber').onkeydown = (e) => {
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  e.preventDefault();
  if (e.key === 'Enter' && /^\d+$/.test($('#pageNumber').value.trim())) goToPage(Number($('#pageNumber').value.trim()));
  $('#pageNumber').blur();
  updatePageNavigation();
};
window.addEventListener('scroll', schedulePageNavigation, { passive: true });
updatePageNavigation();

// ブラウザのズーム（Ctrl＋ホイール）や別の画面への移動で解像度が変わったら描き直す
(function watchDpr() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
    rerenderVisible();
    watchDpr();
  }, { once: true });
})();

function rerenderVisible() {
  for (const r of state.rows) if (r.visible) renderPage(r);
}

applyView();
viewSel.onchange = () => {
  applyView();
  if (viewSel.value === 'ja' && !state.enabled && state.pdf) start(); // 訳文だけ見たいなら翻訳も始める
};

// ---------- PDF読み込み ----------
async function load() {
  if (!fileUrl) { setStatus('PDFのURLが指定されていません'); return; }
  let name = fileUrl;
  try { name = decodeURIComponent(fileUrl.split('?')[0].split('/').pop()) || fileUrl; } catch {}
  state.name = name;
  $('#filename').textContent = name;
  $('#filename').title = name;
  document.title = name + ' - PDF翻訳ビューア';

  setStatus('PDFを読み込み中…');
  try {
    state.pdf = await pdfjsLib.getDocument({ url: fileUrl }).promise;
  } catch (e) {
    console.error(e);
    const hint = fileUrl.startsWith('file:')
      ? '（ローカルファイルは、拡張機能の詳細で「ファイルのURLへのアクセスを許可する」をオンにしてください）'
      : '';
    setStatus('PDFを開けませんでした ' + hint);
    return;
  }
  await buildRows();
  setStatus('');
}

async function buildRows() {
  const cs = getComputedStyle(pagesEl);
  const inner = pagesEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const colWidth = Math.floor((inner - GAP) / 2);
  state.fit = inner / colWidth;
  applyZoom();

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const r = e.target._row;
      r.visible = e.isIntersecting;
      if (e.isIntersecting) {
        renderPage(r);
        if (state.translator?.previewPage) previewTranslatedPage(r, state.translator).catch(console.error);
      } else {
        releasePage(r); // 画面から遠いページの画像は捨てる（戻ってきたら描き直す）
      }
    }
    enqueueVisiblePages();
    schedulePageNavigation();
  }, { rootMargin: '700px 0px' });

  for (let i = 1; i <= state.pdf.numPages; i++) {
    const page = await state.pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: colWidth / base.width });

    const row = document.createElement('section');
    row.className = 'row';
    const [left, srcLayer] = makePage(vp, 'orig');
    const [right, dstLayer] = makePage(vp, 'trans');
    row.append(left, right);
    pagesEl.appendChild(row);

    const r = {
      index: i, page, vp, left, right, srcLayer, dstLayer,
      renderP: null, renderScale: 0, srcCanvas: null, scale: 1, blocks: null, busy: false,
      translated: false, queued: false, visible: false,
    };
    row._row = r;
    state.rows.push(r);
    io.observe(row);
  }
  updatePageNavigation(1);
  schedulePageNavigation();
  if (state.fitMode) fitToViewport(state.fitMode);
}

function makePage(vp, cls) {
  const box = document.createElement('div');
  box.className = 'page ' + cls;
  box.style.width = vp.width + 'px';
  box.style.height = vp.height + 'px';
  const layer = document.createElement('div');
  layer.className = 'layer';
  box.appendChild(layer);
  return [box, layer];
}

function makeCanvas(vp, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width * scale);
  canvas.height = Math.floor(vp.height * scale);
  canvas.style.width = vp.width + 'px';
  canvas.style.height = vp.height + 'px';
  return canvas;
}

// 原文もcanvas画像で表示するため、画面の解像度・拡大率に余裕を持たせて描く。
function pixelScale(r) {
  const want = (window.devicePixelRatio || 1) * viewZoom() * RENDER_QUALITY;
  return Math.min(want, Math.sqrt(MAX_CANVAS_PIXELS / (r.vp.width * r.vp.height)));
}

// 古いcanvasを新しいものに差し替える（描き終わってから入れ替えるので、ちらつかない）
function swapCanvas(box, canvas) {
  const old = box.querySelector(':scope > canvas');
  if (old) { old.width = old.height = 0; old.replaceWith(canvas); } // width=0 でメモリをすぐ解放
  else box.prepend(canvas);
}

// 左に原文を描画し、右にはその複製を置く（翻訳したブロックだけ上から差し替える）
function renderPage(r) {
  const scale = pixelScale(r);
  if (r.renderP && Math.abs(r.renderScale - scale) < 0.01) return r.renderP;
  r.renderScale = scale;
  r.renderP = (async () => {
    const canvas = makeCanvas(r.vp, scale);
    await r.page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: r.vp,
      transform: [scale, 0, 0, scale, 0, 0],
    }).promise;
    if (r.renderScale !== scale) { canvas.width = 0; return r.renderP; } // 描いている間に倍率が変わった
    const copy = makeCanvas(r.vp, scale);
    copy.getContext('2d').drawImage(canvas, 0, 0);
    swapCanvas(r.left, canvas);
    swapCanvas(r.right, copy);
    r.srcCanvas = canvas;
    r.scale = scale;
  })();
  return r.renderP;
}

function releasePage(r) {
  if (r.busy || !r.srcCanvas) return; // 翻訳中のページは画像を使うので残す
  for (const box of [r.left, r.right]) {
    const c = box.querySelector(':scope > canvas');
    if (c) { c.width = c.height = 0; c.remove(); }
  }
  r.srcCanvas = null;
  r.renderP = null;
  r.renderScale = 0;
}

// ---------- レイアウト解析（文字 → 行 → ブロック） ----------
function fontInfo(page, styles, fontName) {
  let f = null;
  try { if (page.commonObjs.has(fontName)) f = page.commonObjs.get(fontName); } catch {}
  const name = f?.name || '';
  const family = styles[fontName]?.fontFamily || '';
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) && v >= lo && v <= hi ? v : d);
  return {
    bold: !!(f?.bold || f?.black) || /bold|black|heavy|semibold|demi|medi|CMBX|-B$/i.test(name),
    sans: family === 'sans-serif' || /sans|helvet|arial|gothic|verdana|calibri/i.test(name),
    ascent: clamp(f?.ascent, 0.6, 1.1, 0.85),
    descent: clamp(-(f?.descent ?? NaN), 0.1, 0.4, 0.25),
  };
}

function getPageBlocks(r) {
  if (r.blocks) return Promise.resolve(r.blocks);
  // 全文を先に読む場合も、フォント情報を読み込んでから段落を判定する。
  return r.blocksP ??= r.page.getOperatorList().then(() => extractBlocks(r)).then((blocks) => (r.blocks = blocks)).catch((e) => {
    r.blocksP = null;
    throw e;
  });
}

async function extractBlocks(r) {
  const tc = await r.page.getTextContent();
  const fonts = {};
  const font = (n) => (fonts[n] ??= fontInfo(r.page, tc.styles, n));

  // 1) テキスト片を画面座標に変換（回転した文字＝arXivの縦書きIDなどは除外）
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = pdfjsLib.Util.transform(r.vp.transform, it.transform);
    const h = Math.abs(d);
    if (h < 1 || a <= 0 || Math.abs(b) + Math.abs(c) > h * 0.05) continue;
    if (tc.styles[it.fontName]?.vertical) continue;
    const fi = font(it.fontName);
    items.push({
      x0: e, x1: e + it.width * r.vp.scale, base: f, h, str: it.str, fi,
      top: f - h * fi.ascent, bottom: f + h * fi.descent,
    });
  }

  // 2) 行にまとめる
  const lines = [];
  let ln = null;
  for (const it of items) {
    const same = ln &&
      Math.abs(it.base - ln.base) < Math.max(it.h, ln.h) * 0.5 &&
      it.x0 > ln.x1 - ln.h * 0.5 &&
      it.x0 - ln.x1 < ln.h * 1.0;
    if (!same) {
      if (ln) lines.push(ln);
      ln = { ...it, text: it.str, main: it.str.length, chars: 0, boldChars: 0, sansChars: 0 };
    } else {
      const space = it.x0 - ln.x1 > ln.h * 0.12 && !/\s$/.test(ln.text) && !/^\s/.test(it.str);
      ln.text += (space ? ' ' : '') + it.str;
      ln.x1 = Math.max(ln.x1, it.x1);
      ln.top = Math.min(ln.top, it.top);
      ln.bottom = Math.max(ln.bottom, it.bottom);
      // 行の文字サイズ・ベースラインは一番長い片（＝本文）に合わせる（上付き文字などに引っ張られない）
      if (it.str.length > ln.main) { ln.main = it.str.length; ln.h = it.h; ln.base = it.base; }
    }
    const n = it.str.replace(/\s/g, '').length;
    ln.chars += n;
    if (it.fi.bold) ln.boldChars += n;
    if (it.fi.sans) ln.sansChars += n;
  }
  if (ln) lines.push(ln);
  for (const l of lines) {
    l.text = l.text.trim();
    l.bold = l.boldChars > l.chars / 2;
  }

  // 3) 行を段落ブロックにまとめる
  const blocks = [];
  let bk = null;
  for (const l of lines) {
    if (bk && canJoin(bk, l)) {
      const prev = bk.lines.at(-1);
      bk.pitch ??= l.base - prev.base;
      bk.lines.push(l);
      bk.x0 = Math.min(bk.x0, l.x0);
      bk.x1 = Math.max(bk.x1, l.x1);
      bk.top = Math.min(bk.top, l.top);
      bk.bottom = Math.max(bk.bottom, l.bottom);
    } else {
      bk = { lines: [l], h: l.h, pitch: null, x0: l.x0, x1: l.x1, top: l.top, bottom: l.bottom };
      blocks.push(bk);
    }
  }

  const body = bodyFontSize(blocks);
  for (const b of blocks) {
    let text = '';
    let chars = 0, boldChars = 0, sansChars = 0;
    for (const l of b.lines) {
      if (!text) text = l.text;
      else if (/[a-z]-$/.test(text) && /^[a-z]/.test(l.text)) text = text.slice(0, -1) + l.text; // 行末ハイフンをつなぐ
      else text += ' ' + l.text;
      chars += l.chars; boldChars += l.boldChars; sansChars += l.sansChars;
    }
    b.text = text;
    b.bold = boldChars > chars / 2;
    b.sans = sansChars > chars / 2;
    b.align = alignOf(b, r.vp.width);
    b.translate = shouldTranslate(b, body);
  }
  return blocks;
}

function canJoin(bk, l) {
  const prev = bk.lines.at(-1);
  if (Math.abs(l.h - bk.h) > bk.h * 0.2) return false;          // 文字サイズが違う
  if (l.bold !== prev.bold) return false;                        // 見出し ↔ 本文
  if (Math.min(l.x1, bk.x1) <= Math.max(l.x0, bk.x0)) return false; // 横に重ならない（別の段）
  const pitch = l.base - prev.base;
  if (bk.pitch == null ? (pitch < bk.h * 0.9 || pitch > bk.h * 2.0)
                       : Math.abs(pitch - bk.pitch) > bk.h * 0.3) return false; // 行送りが違う
  // 中央揃えのタイトルなどは行の長さが違っても続けてよい
  if (isCentered([prev, l], bk.h)) return true;
  // 文が終わった行が「短い」か、次の行が字下げされている → 新しい段落
  const right = Math.max(bk.x1, l.x1);
  const prevShort = prev.x1 < right - bk.h * 1.5;
  const indented = l.x0 > bk.x0 + bk.h * 0.8;
  if (/[.!?:。．！？：]['")\]]*$/.test(prev.text) && (prevShort || indented)) return false;
  // 1行だけの短い行（見出しなど）の後に長い行が来た
  if (bk.lines.length === 1 && prev.x1 - prev.x0 < (l.x1 - l.x0) * 0.6) return false;
  return true;
}

// どの行も左右の余白が同じ（＝中央揃え）
function isCentered(lines, h) {
  const L = Math.min(...lines.map((l) => l.x0));
  const R = Math.max(...lines.map((l) => l.x1));
  return lines.some((l) => l.x0 - L > h)
    && lines.every((l) => Math.abs((l.x0 - L) - (R - l.x1)) < h);
}

function alignOf(b, pageWidth) {
  // 1行だけでページ中央にある（タイトル・著者名など）
  if (b.lines.length < 2) return Math.abs((b.x0 + b.x1) / 2 - pageWidth / 2) < b.h * 2 ? 'center' : 'left';
  const w = b.x1 - b.x0;
  if (isCentered(b.lines, b.h)) return 'center';
  const full = b.lines.slice(0, -1).filter((l) => l.x1 - l.x0 > w * 0.9).length;
  return full >= (b.lines.length - 1) / 2 ? 'justify' : 'left';
}

// ページ内で一番多く使われている文字サイズ＝本文サイズ
function bodyFontSize(blocks) {
  const hist = new Map();
  for (const b of blocks) for (const l of b.lines) {
    const k = Math.round(l.h * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + l.chars);
  }
  let best = 10, max = -1;
  for (const [k, v] of hist) if (v > max) { max = v; best = k; }
  return best;
}

// 図中のラベル・数式・表のセルなどは訳さず原文のまま残す
function shouldTranslate(b, body) {
  const t = b.text;
  const nonSpace = t.replace(/\s/g, '').length;
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 2 || letters / nonSpace < 0.55) return false;
  const words = (t.match(/\p{L}{2,}/gu) || []).length;
  if (b.lines.length > 1 && words / b.lines.length < 2.5) return false; // 表の列など
  if (b.h < body * 0.7 && words < 6) return false;                      // 図の中の小さい文字
  return words >= 3 || ((b.bold || b.h > body * 1.15) && words >= 1);
}

// ---------- 色の推定（背景色と文字色をページ画像から拾う） ----------
function pickColors(r, pix, b) {
  const W = pix.width, H = pix.height, d = pix.data, k = r.scale;
  const x0 = Math.max(0, Math.floor((b.x0 - 3) * k)), x1 = Math.min(W, Math.ceil((b.x1 + 3) * k));
  const y0 = Math.max(0, Math.floor((b.top - 3) * k)), y1 = Math.min(H, Math.ceil((b.bottom + 3) * k));
  const step = Math.max(1, Math.round(k));
  // 背景：ブロックとその周りで一番多い色。文字の画素は少数派なので、行間が詰まっていても背景色が選ばれる
  const hist = new Map();
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      let e = hist.get(key);
      if (!e) hist.set(key, (e = [0, 0, 0, 0]));
      e[0]++; e[1] += d[i]; e[2] += d[i + 1]; e[3] += d[i + 2];
    }
  }
  let best = null;
  for (const e of hist.values()) if (!best || e[0] > best[0]) best = e;
  const bg = best ? [1, 2, 3].map((j) => Math.round(best[j] / best[0])) : [255, 255, 255];
  // 文字色：ブロック内で背景から一番離れた色
  let fg = null, far = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const dist = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
      if (dist > far) { far = dist; fg = [d[i], d[i + 1], d[i + 2]]; }
    }
  }
  const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  if (!fg || far < 90) fg = lum(bg) > 128 ? [17, 17, 17] : [240, 240, 240];
  return { bg, fg };
}

// ---------- 訳文をブロックの枠に収める ----------
function fitText(el, b) {
  el.classList.remove('overflow'); // 訳し直したときのため
  const ratio = b.pitch ? Math.min(1.6, Math.max(1.2, b.pitch / b.h)) : 1.2;
  el.style.lineHeight = ratio;
  const fits = () => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
  let hi = b.h * 0.95, lo = b.h * 0.4;
  el.style.fontSize = hi + 'px';
  if (fits()) return;
  el.style.fontSize = lo + 'px';
  if (!fits()) { el.classList.add('overflow'); return; } // 最小でも入りきらない → 下に伸ばす
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + 'px';
    if (fits()) lo = mid; else hi = mid;
  }
  el.style.fontSize = lo + 'px';
}

function placeBlock(r, b) {
  const pad = 1.5;
  const box = (el) => {
    el.style.left = b.x0 - pad + 'px';
    el.style.top = b.top - pad + 'px';
    el.style.width = b.x1 - b.x0 + pad * 2 + 'px';
    el.style.height = b.bottom - b.top + pad * 2 + 'px';
  };
  const src = document.createElement('div');
  src.className = 'src';
  box(src);
  r.srcLayer.appendChild(src);

  const el = document.createElement('div');
  el.className = 'blk pending';
  el._src = src;
  el._b = b;
  box(el);
  r.dstLayer.appendChild(el);

  // 対応する原文と訳文をホバーで強調し、訳文側には操作ボタンを出す
  const hot = (on) => { src.classList.toggle('hot', on); el.classList.toggle('hot', on); };
  el._hot = hot;
  src.onmouseenter = () => hot(true);
  src.onmouseleave = () => hot(false);
  el.onmouseenter = () => { hot(true); showTools(el); };
  el.onmouseleave = () => { hot(false); hideToolsSoon(); };
  return el;
}

function fillBlock(el, b, text) {
  b.ja = text; // PDF保存用に覚えておく
  el.classList.remove('pending');
  el.classList.add(b.bold ? 'bold' : b.sans ? 'sans' : 'serif');
  el.style.textAlign = b.align;
  el.style.background = `rgb(${b.colors.bg})`;
  el.style.color = `rgb(${b.colors.fg})`;
  el.classList.toggle('off', !!b.hidden);
  renderRuns(el, text);
  fitText(el, b);
}

// 訳せなかった段落：訳を重ねず原文を見せる。マウスを乗せると「訳し直す」が出る
function markFailed(el, b) {
  b.failed = true;
  el.classList.remove('pending');
  el.classList.add('off');
}

// 訳文を描く。$…$ の数式は記号に直し、下付き・上付きは小さい文字にする
function renderRuns(el, text) {
  el.replaceChildren(...toRuns(text).map((run) => {
    if (!run.s) return document.createTextNode(run.t);
    const e = document.createElement(run.s); // <sub> / <sup>
    e.textContent = run.t;
    return e;
  }));
}

// ---------- 段落ごとの操作（訳し直す・原文を見る） ----------
const tools = document.createElement('div');
tools.className = 'blk-tools';
const redoBtn = document.createElement('button');
redoBtn.textContent = '↻ 訳し直す';
redoBtn.title = 'この段落だけ、もう一度翻訳します';
const toggleBtn = document.createElement('button');
tools.append(redoBtn, toggleBtn);
let toolsFor = null;
let hideTimer = 0;

function showTools(el) {
  clearTimeout(hideTimer);
  if (el.classList.contains('pending')) { tools.remove(); return; }
  toolsFor = el;
  const b = el._b;
  // Chrome内蔵は何度訳しても同じ結果になるので、訳し直しは Gemini のときだけ
  redoBtn.hidden = (b.hidden && !b.failed) || state.engine !== 'gemini' || (state.translator?.ready && !state.translator.completed);
  toggleBtn.hidden = !!b.failed; // まだ訳がない段落は、表示の切り替えもできない
  toggleBtn.textContent = b.hidden ? '訳を表示' : '原文を表示';
  toggleBtn.title = b.hidden ? 'この段落の訳を元に戻します' : 'この段落の訳を消して、原文が見えるようにします';
  // 段落の右上（枠のすぐ外）に置く。ページの上端に近いときは枠の内側
  const top = parseFloat(el.style.top);
  tools.style.top = (top >= 20 ? top - 20 : top) + 'px';
  tools.style.left = parseFloat(el.style.left) + parseFloat(el.style.width) + 'px';
  el.parentNode.appendChild(tools);
}

function hideToolsSoon() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { tools.remove(); toolsFor = null; }, 300);
}
tools.onmouseenter = () => { clearTimeout(hideTimer); toolsFor?._hot(true); };
tools.onmouseleave = () => { toolsFor?._hot(false); hideToolsSoon(); };

toggleBtn.onclick = () => {
  const el = toolsFor;
  if (!el) return;
  const b = el._b;
  b.hidden = !b.hidden; // PDF保存でもこの段落は訳さず原文のままになる
  el.classList.toggle('off', b.hidden);
  if (b.hidden) setStatus('この段落の訳を消しました（もう一度マウスを乗せて「訳を表示」で戻せます）');
  showTools(el);
};
redoBtn.onclick = () => { if (toolsFor) redoBlock(toolsFor); };

async function redoBlock(el) {
  const b = el._b, tr = state.translator;
  if (!tr || el.classList.contains('pending')) return;
  tools.remove();
  el.classList.add('pending');
  const finish = beginTranslation();
  try {
    const t = await tr.retranslateBlock(b);
    if (tr !== state.translator) return;
    if (b.failed) { b.failed = false; b.hidden = false; }
    fillBlock(el, b, t);
  } catch (e) {
    if (tr !== state.translator) return;
    console.error(e);
    setStatus('訳し直しに失敗しました: ' + e.message);
  } finally {
    el.classList.remove('pending');
    finish();
  }
}

// ---------- 翻訳 ----------
async function start(engine = state.engine) {
  const sourceLanguage = srcSel.value;
  const targetLanguage = dstSel.value;
  localStorage.setItem('src', sourceLanguage);
  localStorage.setItem('dst', targetLanguage);
  if (sourceLanguage === targetLanguage) { setStatus('原文と訳が同じ言語です'); return; }
  if (!state.pdf) return;
  if (engine !== 'chrome' && engine !== 'gemini') {
    setStatus('ローカルAIかGeminiの翻訳ボタンを選んでください'); return;
  }
  const { geminiKey, geminiModel } = state.settings;
  if (engine === 'gemini' && !geminiKey) {
    setStatus('設定でGeminiのAPIキーを入力してください'); showSettings(); return;
  }

  const previousEngine = state.engine;
  const version = ++state.translationVersion;
  const controller = new AbortController();
  state.engine = engine;

  const finish = beginTranslation();
  let prepared = false;
  try {
    let translator;
    if (engine === 'gemini') {
      const onProgress = (message) => { if (version === state.translationVersion) setStatus(message); };
      translator = createDocumentTranslator({
        rows: state.rows,
        getBlocks: getPageBlocks,
        onProgress,
        onPreview: (r) => { if (translator === state.translator) previewTranslatedPage(r, translator).catch(console.error); },
        onResetPreview: () => { if (translator === state.translator) clearTranslationPreviews(); },
        signal: controller.signal,
        translator: createGeminiTranslator({
          apiKey: geminiKey, model: geminiModel, sourceLanguage, targetLanguage,
          onWait: onProgress, signal: controller.signal,
        }),
      });
    } else {
      translator = await createChromeTranslator(sourceLanguage, targetLanguage);
      if (!translator) return; // 理由はステータスに表示済み
    }
    if (version !== state.translationVersion) return;
    // 切替先の準備が成功するまでは、既存の翻訳結果を使えるようにしておく。
    state.translationAbort?.abort();
    state.translationAbort = controller;
    state.translator = translator;
    prepared = true;

    // やり直し：状態をリセット
    state.queue = [];
    for (const r of state.rows) {
      r.translated = false;
      r.queued = false;
      r.previewEls = new Map();
      for (const b of r.blocks || []) b.ja = null;
      r.srcLayer.replaceChildren();
      r.dstLayer.replaceChildren();
    }
    state.enabled = true;
    setStatus('翻訳中…');
    if (translator.ready) {
      const finishDocument = beginTranslation();
      translator.ready().then(() => {
        if (translator === state.translator) setStatus('全文の翻訳が完了しました');
      }).catch((e) => {
        if (translator === state.translator) setStatus('全文の翻訳に失敗しました: ' + e.message);
      }).finally(finishDocument);
    }
    enqueueVisiblePages();
  } catch (e) {
    if (version === state.translationVersion) setStatus('翻訳の準備に失敗しました: ' + e.message);
  } finally {
    if (!prepared) {
      controller.abort();
      if (version === state.translationVersion) state.engine = previousEngine;
    }
    finish();
  }
}

// Chrome内蔵の Translator API（1段落ずつ順に訳す）
async function createChromeTranslator(sourceLanguage, targetLanguage) {
  if (!('Translator' in self)) {
    setStatus('このChromeはTranslator API未対応です（Chrome 138以降が必要）');
    return null;
  }
  try {
    const avail = await Translator.availability({ sourceLanguage, targetLanguage });
    if (avail === 'unavailable') { setStatus(`${sourceLanguage}→${targetLanguage} は未対応の組み合わせです`); return null; }
    setStatus(avail === 'available' ? '準備中…' : '翻訳モデルをダウンロード中…');
    const tr = await Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          setStatus(`翻訳モデルをダウンロード中… ${Math.round(e.loaded * 100)}%`);
        });
      },
    });
    return {
      async translateBatch(texts, onEach) {
        for (let i = 0; i < texts.length; i++) {
          if (onEach(i, await tr.translate(texts[i])) === false) return;
        }
      },
    };
  } catch (e) {
    console.error(e);
    setStatus('翻訳の準備に失敗しました: ' + e.message);
    return null;
  }
}

function enqueueVisiblePages() {
  if (!state.enabled) return;
  const visible = state.rows.filter((r) => r.visible);
  const targets = [...visible];
  if (state.engine === 'chrome' && visible.length) {
    const last = visible.at(-1).index;
    targets.push(...state.rows.slice(last, last + LOCAL_TRANSLATION_LOOKAHEAD));
  }
  for (const r of targets) enqueue(r);
  // 先読み中に大きくスクロールしたら、移動先とその先を古い先読みより優先する。
  const priority = new Map(targets.map((r, i) => [r, i]));
  state.queue.sort((a, b) => (priority.get(a) ?? Infinity) - (priority.get(b) ?? Infinity));
}

function enqueue(r) {
  if (r.queued || r.translated) return;
  r.queued = true;
  r.failed = false;
  state.queue.push(r);
  pump();
}

async function pump() {
  if (state.working) return;
  state.working = true;
  let error = null;
  let errorTranslator = null;
  while (state.queue.length) {
    const r = state.queue.shift();
    const translator = state.translator;
    const finish = beginTranslation();
    if (!state.exporting && !translator.ready) setStatus(`翻訳中… ${r.index}/${state.rows.length}ページ`);
    try {
      // 途中で翻訳方法や言語を変更しても、その時点の翻訳エンジンを使う
      await translatePage(r, translator);
    } catch (e) {
      if (translator !== state.translator) continue;
      console.error(e);
      error = e;
      errorTranslator = translator;
      r.queued = false;
      r.failed = true;
      showPageError(r, e);
    } finally {
      finish();
    }
  }
  state.working = false;
  if (error && errorTranslator === state.translator && state.rows.some((r) => r.failed)) setStatus('翻訳エラー: ' + error.message);
  else if (!state.exporting) setStatus(state.translator.ready
    ? '全文の翻訳が完了しました' : '先読み範囲の翻訳が完了しました');
}

// 訳せなかった段落は原文の表示に戻し、ページの上にエラーと「再試行」ボタンを出す
function showPageError(r, e) {
  for (const el of r.dstLayer.querySelectorAll('.blk.pending')) { el._src?.remove(); el.remove(); }
  for (const el of r.dstLayer.querySelectorAll('.page-msg')) el.remove();
  const msg = document.createElement('div');
  msg.className = 'page-msg err';
  msg.append('翻訳エラー: ' + e.message + ' ');
  const retry = document.createElement('button');
  const translator = state.translator;
  retry.textContent = translator.missingCount
    ? `不足${translator.missingCount}段落だけ再翻訳`
    : translator.ready ? '全文を再試行' : 'このページを再試行';
  if (translator.missingCount) retry.title = '全文を文脈として添え、不足分だけを翻訳します。追加のAPIリクエストを通常1回使います。';
  retry.onclick = () => {
    if (translator !== state.translator) return;
    if (translator.missingCount) return repairMissingTranslations();
    msg.remove();
    return translator.ready ? start() : enqueue(r);
  };
  msg.append(retry);
  r.dstLayer.appendChild(msg);
}

async function repairMissingTranslations() {
  const translator = state.translator;
  if (!translator?.missingCount || repairingTranslators.has(translator)) return;
  repairingTranslators.add(translator);
  const finish = beginTranslation();
  for (const r of state.rows) {
    for (const button of r.dstLayer.querySelectorAll('.page-msg button')) button.disabled = true;
  }
  try {
    await translator.repairMissing();
    if (translator !== state.translator) return;
    for (const r of state.rows) {
      r.failed = false;
      for (const el of r.dstLayer.querySelectorAll('.page-msg')) el.remove();
    }
    setStatus('全文の翻訳が完了しました');
    for (const r of state.rows) if (r.visible) enqueue(r);
  } catch (e) {
    if (translator !== state.translator) return;
    setStatus('不足分の再翻訳に失敗しました: ' + e.message);
    for (const r of state.rows) if (r.visible) showPageError(r, e);
  } finally {
    repairingTranslators.delete(translator);
    finish();
  }
}

async function translatePage(r, translator) {
  r.busy = true;
  try {
    await translatePageInner(r, translator);
  } finally {
    r.busy = false;
    if (!r.visible) releasePage(r);
  }
}

// 未完成の段落には何も重ねず、原文を残す。完成済みの段落だけを暫定表示する。
async function previewTranslatedPage(r, translator) {
  if (!r?.visible || translator !== state.translator || translator.completed || !translator.previewPage(r).length) return;
  await renderPage(r);
  if (!r.visible || translator !== state.translator || translator.completed) return;
  const entries = translator.previewPage(r);
  let pix;
  r.previewEls ??= new Map();
  for (const { block: b, text } of entries) {
    let el = r.previewEls.get(b);
    if (el && b.ja === text) continue;
    if (!b.colors) {
      pix ??= r.srcCanvas.getContext('2d').getImageData(0, 0, r.srcCanvas.width, r.srcCanvas.height);
      b.colors = pickColors(r, pix, b);
    }
    if (!el) { el = placeBlock(r, b); r.previewEls.set(b, el); }
    fillBlock(el, b, text);
  }
}

function clearTranslationPreviews() {
  for (const r of state.rows) {
    for (const [b, el] of r.previewEls || []) {
      el._src?.remove();
      el.remove();
      b.ja = null;
    }
    r.previewEls?.clear();
  }
}

async function translatePageInner(r, translator) {
  if (translator.ready) await translator.ready();
  if (translator !== state.translator) return;
  await renderPage(r);
  await getPageBlocks(r);
  if (translator !== state.translator) return;
  if (r.blocks.some((b) => b.translate && !b.colors)) {
    // 背景色・文字色は訳文に関係ないので、ページ画像の読み出し（重い）は1ページにつき1回だけ
    const pix = r.srcCanvas.getContext('2d').getImageData(0, 0, r.srcCanvas.width, r.srcCanvas.height);
    for (const b of r.blocks) if (b.translate) b.colors = pickColors(r, pix, b);
  }
  if (translator !== state.translator) return; // 待っている間にやり直された
  for (const b of r.blocks) { b.ja = null; b.failed = false; }
  r.srcLayer.replaceChildren();
  r.dstLayer.replaceChildren();
  r.previewEls?.clear();

  const targets = r.blocks.filter((b) => b.translate);
  if (!targets.length) {
    const msg = document.createElement('div');
    msg.className = 'page-msg';
    msg.textContent = '翻訳するテキストがありません（画像だけのページかもしれません）';
    r.dstLayer.appendChild(msg);
    r.translated = true;
    return;
  }

  const els = targets.map((b) => placeBlock(r, b));
  const onEach = (i, text) => {
    if (translator !== state.translator) return false; // 言語や設定を切り替えられた
    if (text == null) { markFailed(els[i], targets[i]); return; } // 訳せなかった段落は原文のまま
    fillBlock(els[i], targets[i], text);
  };
  if (translator.translatePage) await translator.translatePage(r, onEach);
  else await translator.translateBatch(targets.map((b) => b.text), onEach);
  if (translator !== state.translator) return;
  r.translated = true;
}

// ---------- PDFとして保存 ----------
function canExportTranslation() {
  return state.enabled && !state.translator?.missingCount
    && (!state.translator?.ready || state.translator.completed)
    && state.rows.some((r) => r.translated && r.blocks?.some((b) => b.ja));
}

function closeDownloadMenu() {
  $('#downloadMenu').hidden = true;
  $('#download').setAttribute('aria-expanded', 'false');
}

function toggleDownloadMenu() {
  const menu = $('#downloadMenu');
  $('#downloadOriginal').disabled = !state.pdf || state.exporting;
  $('#downloadTranslated').disabled = !canExportTranslation() || state.exporting;
  $('#downloadBoth').disabled = !canExportTranslation() || state.exporting;
  menu.hidden = !menu.hidden;
  $('#download').setAttribute('aria-expanded', String(!menu.hidden));
}

async function download(mode) {
  closeDownloadMenu();
  if (!state.pdf) return;
  if (!['orig', 'ja', 'both'].includes(mode)) return;
  if (mode !== 'orig' && !canExportTranslation()) { setStatus('翻訳が完了してから保存してください'); return; }
  const btn = $('#download');
  btn.disabled = true;
  state.exporting = true;
  try {
    if (mode !== 'orig') {
      await translateAll();
    }
    setStatus('PDFを作成中…');
    // 原文はPDFのバイト列をそのまま保存する。翻訳処理も書き込み用ライブラリも不要。
    const original = await state.pdf.getData();
    const bytes = mode === 'orig' ? original : await (await import('./export.js')).exportPdf(mode, original, state.rows, setStatus);
    const base = state.name.replace(/\.pdf$/i, '');
    const suffix = { orig: '', ja: '_ja', both: '_対訳' }[mode];
    saveFile(bytes, `${base}${suffix}.pdf`);
    setStatus(mode === 'both'
      ? '保存しました（原文と訳文のページが交互に並びます。PDFビューアの見開き表示で左右に並べて読めます）'
      : '保存しました');
  } catch (e) {
    console.error(e);
    setStatus('保存に失敗しました: ' + e.message);
  } finally {
    state.exporting = false;
    btn.disabled = false;
  }
}

// まだ訳していないページもすべて訳し終わるまで待つ
async function translateAll() {
  const translator = state.translator;
  if (translator.ready) await translator.ready();
  if (translator !== state.translator) throw new Error('翻訳がやり直されました');
  for (const r of state.rows) enqueue(r);
  for (;;) {
    if (translator !== state.translator) throw new Error('翻訳がやり直されました');
    const done = state.rows.filter((r) => r.translated).length;
    const failed = state.rows.filter((r) => r.failed).length;
    if (done + failed === state.rows.length) {
      if (failed) throw new Error(`${failed}ページの翻訳に失敗しました`);
      return;
    }
    setStatus(`保存のため全ページを翻訳中… ${done}/${state.rows.length}ページ`);
    await new Promise((res) => setTimeout(res, 300));
  }
}

function saveFile(bytes, filename, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- 設定 ----------
async function showSettings() {
  const next = await openSettings(state.settings);
  if (!next) return;
  state.settings = next;
}

// 翻訳はいらないとき：このPDFだけ、いつものビューアで開き直す
if (fileUrl && self.chrome?.tabs) {
  $('#openOriginal').hidden = false;
  $('#openOriginal').onclick = async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.runtime.sendMessage({ type: 'openOriginal', tabId: tab.id, url: fileUrl });
  };
}

$('#startLocal').onclick = () => start('chrome');
$('#startGemini').onclick = () => start('gemini');
$('#openSettings').onclick = showSettings;
$('#download').onclick = toggleDownloadMenu;
$('#downloadOriginal').onclick = () => download('orig');
$('#downloadTranslated').onclick = () => download('ja');
$('#downloadBoth').onclick = () => download('both');
citationDialog = createCitationDialog({
  document, fileUrl, getPdf: () => state.pdf,
  download: (text, filename) => saveFile(new TextEncoder().encode(text), filename, 'text/plain;charset=utf-8'),
});
$('#cite').onclick = () => { closeDownloadMenu(); return citationDialog.open(); };
window.addEventListener('pointerdown', (e) => {
  if (!$('#downloadMenu').hidden && !e.target?.closest?.('.download-control')) closeDownloadMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDownloadMenu();
  handleZoomKey(e);
});
srcSel.onchange = dstSel.onchange = () => { if (state.enabled) start(); };

disableNativeZoom(self.chrome?.tabs).catch(() => {});

load();
