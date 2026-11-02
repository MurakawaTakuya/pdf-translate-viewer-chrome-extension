import * as pdfjsLib from './lib/pdf.min.mjs';
import { loadSettings, openSettings } from './settings.js';
import { createKeyedGeminiTranslator as createGeminiTranslator } from './gemini.js';
import { createDocumentTranslator } from './document-translator.js';
import { extractBlocks } from './pdf-layout.js';
import { loadTranslationBlocks } from './translation-scope.js';
import { createPdfLoadProgress } from './pdf-load-progress.js';
import { horizontalZoomShift, verticalZoomShift } from './zoom-anchor.js';
import { toRuns } from './math.js';
import { disableNativeZoom } from './native-zoom.js';
import { createCitationDialog } from './citation-ui.js';
import { createSourceTextLayer } from './source-text.js';
import { resolvePdfSource, viewerDestinationUrl } from './pdf-source.js';
import { protectedRuns, mathImage } from './protected-spans.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const $ = (s) => document.querySelector(s);
const pagesEl = $('#pages');
const pdfLoadProgress = createPdfLoadProgress($('#pdfLoadProgress'), $('#pdfLoadProgressFill'));
const srcSel = $('#src');
const dstSel = $('#dst');
const viewSel = $('#view');
const pdfSource = await resolvePdfSource({
  search: location.search, mimeHandler: self.chrome?.mimeHandler, storage: self.chrome?.storage?.session,
  getFrameUrl: self.chrome?.webNavigation?.getFrame
    ? async (tabId) => (await self.chrome.webNavigation.getFrame({ tabId, frameId: 0 }))?.url : undefined,
});
const fileUrl = pdfSource.originalUrl;
// 他のサイトに埋め込まれて使われないようにする（ビューアはWebから開ける資源として登録しているため）
// Chrome自身がトップレベルPDFのために作る内部フレームだけは認証済みストリームで許可する。
if (window.top !== window && !pdfSource.fallback) throw new Error('埋め込みでは表示できません');
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
  preparingAbort: null,
  translationVersion: 0,
  translationPair: null,
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
let autoTranslatePending = true;

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
let blockGeminiJob=null;
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
    button.disabled = state.exporting;
    button.classList.toggle('loading', active);
    button.setAttribute('aria-busy', String(active));
    button.textContent = active ? '中断' : label;
    button.setAttribute('aria-label', active ? `${label}の翻訳を中断` : `${label}で翻訳`);
    button.title = active ? `${label}の翻訳を中断` : engine === 'chrome'
      ? 'ローカルAIで翻訳。Chrome内蔵AIを使い、文章は外部に送られません。'
      : 'Geminiで翻訳。PDF全文をGoogleへ送信します。APIキーが必要です。';
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
const ZOOM_SETTLE_MS = 140;
const ZOOM_GESTURE_SENSITIVITY = 0.007; // ピンチ・ホイールの移動量に対する倍率変化
let wheelZoom = 0, wheelZoomFrame = null, zoomSettleTimer = null, zoomGesture = null;

function applyZoom(anchor = null) {
  if (zoomGesture) {
    const gesture = zoomGesture;
    if (gesture.horizontal) gesture.anchor.clientX = gesture.horizontal.pointer
      + horizontalZoomShift(gesture.horizontal, viewZoom() / gesture.base);
    if (gesture.vertical) gesture.anchor.clientY = gesture.vertical.pointer
      + verticalZoomShift(gesture.vertical, viewZoom() / gesture.base);
    anchor ??= gesture.anchor;
    zoomGesture = null;
    clearTimeout(zoomSettleTimer);
    if (wheelZoomFrame !== null) cancelAnimationFrame(wheelZoomFrame);
    wheelZoomFrame = null;
    wheelZoom = 0;
    pagesEl.style.transform = '';
    pagesEl.style.transformOrigin = '';
    pagesEl.classList.remove('zoom-preview');
    gesture.resolve();
  }
  const ratio = anchor ? null : scrollY / Math.max(1, document.documentElement.scrollHeight);
  document.documentElement.style.setProperty('--zoom', viewZoom());
  updateRowWidths();
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  $('#fitWidth').setAttribute('aria-pressed', String(state.fitMode === 'width'));
  $('#fitHeight').setAttribute('aria-pressed', String(state.fitMode === 'height'));
  localStorage.setItem('zoom', state.zoom);
  if (anchor) {
    const rect = anchor.element.getBoundingClientRect();
    scrollTo((window.scrollX || 0) + rect.left + rect.width * anchor.x - anchor.clientX,
      scrollY + rect.top + rect.height * anchor.y - anchor.clientY);
  } else scrollTo(0, ratio * document.documentElement.scrollHeight);
  rerenderVisible();
  schedulePageNavigation();
}

// CSS zoom内のパーセント幅は包含ブロックとの倍率差で補正される。
// ここではCSS pxの幅を明示し、余白用の倍率補正が二重に掛からないようにする。
function setRowWidth(r, available) {
  if (!r.element || !r.vp) return;
  const columns = viewSel.value === 'both' ? 2 : 1;
  const content = r.vp.width * columns + GAP * (columns - 1);
  const scale = zoomGesture?.base ?? viewZoom(); // 操作中はプレビュー前のレイアウト幅を保つ
  r.element.style.width = Math.max(content, available / scale) + 'px';
}

function updateRowWidths() {
  if (!state.rows.length) return;
  const cs = getComputedStyle(pagesEl);
  const available = document.documentElement.clientWidth
    - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  if (available <= 0) return;
  for (const r of state.rows) setRowWidth(r, available);
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

function startZoomGesture(e) {
  if (zoomGesture) return;
  const rect = pagesEl.getBoundingClientRect();
  const clientX = Number.isFinite(e.clientX) ? e.clientX : document.documentElement.clientWidth / 2;
  const clientY = Number.isFinite(e.clientY) ? e.clientY : document.documentElement.clientHeight / 2;
  const pageElement = e.target?.closest?.('.page');
  const rowElement = e.target?.closest?.('.row');
  const row = rowElement?._row
    || state.rows.find((r) => r.left === pageElement || r.right === pageElement)
    || currentFitRow();
  const first = viewSel.value === 'ja' ? row?.right : row?.left;
  // 余白上のピンチでも、幅が変わらない外側コンテナではなくPDFを基準にする。
  const element = pageElement || first || rowElement || pagesEl;
  const box = element.getBoundingClientRect();
  const firstBox = first === element ? box : first?.getBoundingClientRect?.();
  const cs = getComputedStyle(pagesEl);
  const columns = viewSel.value === 'both' ? 2 : 1;
  const width = row?.vp && (row.vp.width * columns + GAP * (columns - 1)) * viewZoom();
  const horizontal = firstBox && Number.isFinite(firstBox.left) && Number.isFinite(width) ? {
    left: firstBox.left, width, pointer: clientX,
    start: parseFloat(cs.paddingLeft) || 0,
    end: document.documentElement.clientWidth - (parseFloat(cs.paddingRight) || 0),
  } : null;
  // いま見ているページではなく文書全体の先頭を使い、途中のページまで上端に固定しない。
  const documentFirst = viewSel.value === 'ja' ? state.rows[0]?.right : state.rows[0]?.left;
  const documentBox = documentFirst === element ? box
    : documentFirst === first ? firstBox : documentFirst?.getBoundingClientRect?.();
  const vertical = Number.isFinite(documentBox?.top) ? {
    top: documentBox.top, pointer: clientY,
    start: $('header').getBoundingClientRect().bottom + (parseFloat(cs.paddingTop) || 0),
  } : null;
  let resolve;
  const finished = new Promise((done) => { resolve = done; });
  zoomGesture = { base: viewZoom(), finished, resolve, horizontal, vertical, anchor: {
    element, clientX, clientY,
    x: box.width ? (clientX - box.left) / box.width : 0,
    y: box.height ? (clientY - box.top) / box.height : 0,
  } };
  pagesEl.style.transformOrigin = `${clientX - rect.left}px ${clientY - rect.top}px`;
  pagesEl.classList.add('zoom-preview');
  for (const r of state.rows) r.renderTask?.cancel();
}

function previewWheelZoom() {
  wheelZoomFrame = null;
  if (!zoomGesture) return;
  state.zoom = Math.min(5, Math.max(0.1, state.zoom * Math.exp(-wheelZoom * ZOOM_GESTURE_SENSITIVITY)));
  wheelZoom = 0;
  state.fitMode = null;
  const scale = viewZoom() / zoomGesture.base;
  const shift = zoomGesture.horizontal ? horizontalZoomShift(zoomGesture.horizontal, scale) : 0;
  const shiftY = zoomGesture.vertical ? verticalZoomShift(zoomGesture.vertical, scale) : 0;
  if (zoomGesture.horizontal) zoomGesture.anchor.clientX = zoomGesture.horizontal.pointer + shift;
  if (zoomGesture.vertical) zoomGesture.anchor.clientY = zoomGesture.vertical.pointer + shiftY;
  pagesEl.style.transform = `translate(${shift}px, ${shiftY}px) scale(${scale})`;
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  $('#fitWidth').setAttribute('aria-pressed', 'false');
  $('#fitHeight').setAttribute('aria-pressed', 'false');
}

function finishZoomGesture() {
  if (!zoomGesture) return;
  if (wheelZoomFrame !== null) {
    cancelAnimationFrame(wheelZoomFrame);
    previewWheelZoom();
  }
  applyZoom();
}

window.addEventListener('wheel', (e) => {
  if (!state.pdf || (!e.ctrlKey && !e.metaKey)) return;
  e.preventDefault();
  if (e.target?.closest?.('dialog[open]') || !e.deltaY) return;
  startZoomGesture(e);
  wheelZoom += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? document.documentElement.clientHeight : 1);
  clearTimeout(zoomSettleTimer);
  zoomSettleTimer = setTimeout(finishZoomGesture, ZOOM_SETTLE_MS);
  if (wheelZoomFrame !== null) return;
  wheelZoomFrame = requestAnimationFrame(previewWheelZoom);
}, { passive: false });

const refit = () => {
  // 横スクロールから独立した固定ヘッダーの分だけ、PDF上端に余白を確保する。
  const height = $('header').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--toolbar-height', `${height}px`);
  if (state.fitMode) fitToViewport(state.fitMode, currentFitRow(), false);
  updateRowWidths();
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
  if (pdfSource.nativeFallback) { await openNativeViewer(); return; }
  if (!fileUrl) { setStatus('PDFのURLが指定されていません'); return; }
  let name = fileUrl;
  try { name = decodeURIComponent(fileUrl.split('?')[0].split('/').pop()) || fileUrl; } catch {}
  state.name = name;
  $('#filename').textContent = name;
  $('#filename').title = name;
  document.title = name + ' - PDF翻訳ビューア';

  setStatus('PDFを読み込み中…');
  pdfLoadProgress.start();
  try {
    const parameters = await pdfSource.parameters((progress) => pdfLoadProgress.update(progress));
    const task = pdfjsLib.getDocument(parameters);
    task.onProgress = (progress) => pdfLoadProgress.update(progress);
    state.pdf = await task.promise;
    pdfLoadProgress.prepare();
    await buildRows();
    // 受信だけで完了扱いにせず、最初のページが見えるまで表示を残す。
    if (state.rows[0]) await renderPage(state.rows[0]);
    pdfLoadProgress.complete();
    setStatus('');
  } catch (e) {
    pdfLoadProgress.fail();
    console.error(e);
    if (pdfSource.fallback) {
      try { await openNativeViewer(); return; } catch (error) { console.error(error); }
    }
    const hint = fileUrl.startsWith('file:')
      ? '（ローカルファイルは、拡張機能の詳細で「ファイルのURLへのアクセスを許可する」をオンにしてください）'
      : '';
    setStatus('PDFを開けませんでした ' + hint);
    return;
  }
  citationDialog?.prefetch();
  await autoTranslateOnOpen();
}

async function autoTranslateOnOpen() {
  if (!autoTranslatePending) return;
  autoTranslatePending = false;
  if (state.settings.autoTranslate === false || state.translationVersion || !state.pdf || !state.rows.length) return;
  dstSel.value = 'ja';
  if (srcSel.value === 'ja') return; // 日本語の原文を日本語へ再翻訳しない。
  await start('chrome');
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
      index: i, element: row, page, vp, left, right, srcLayer, dstLayer,
      renderP: null, renderScale: 0, srcCanvas: null, scale: 1, blocks: null, busy: false,
      translated: false, queued: false, visible: false,
    };
    row._row = r;
    trackSourceHover(r);
    setRowWidth(r, inner);
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
  if (zoomGesture) return zoomGesture.finished.then(() => (r.visible || r.busy) ? renderPage(r) : undefined);
  const scale = pixelScale(r);
  if (r.renderP && Math.abs(r.renderScale - scale) < 0.01) return r.renderP;
  const version = r.renderVersion = (r.renderVersion || 0) + 1;
  r.renderTask?.cancel();
  r.renderScale = scale;
  r.renderP = (async () => {
    const canvas = makeCanvas(r.vp, scale);
    const task = r.page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: r.vp,
      transform: [scale, 0, 0, scale, 0, 0],
    });
    r.renderTask = task;
    try { await task.promise; }
    catch (error) {
      canvas.width = canvas.height = 0;
      if (error.name !== 'RenderingCancelledException') throw error;
      if (r.renderVersion === version) { r.renderP = null; r.renderScale = 0; }
      if (!r.visible && !r.busy) return;
      if (zoomGesture) await zoomGesture.finished;
      if (!r.visible && !r.busy) return;
      return r.renderP || renderPage(r);
    } finally { if (r.renderTask === task) r.renderTask = null; }
    if (r.renderVersion !== version) { canvas.width = canvas.height = 0; return r.renderP; }
    const copy = makeCanvas(r.vp, scale);
    copy.getContext('2d').drawImage(canvas, 0, 0);
    swapCanvas(r.left, canvas);
    swapCanvas(r.right, copy);
    r.srcCanvas = canvas;
    r.scale = scale;
    let cachedPixels;
    for(const block of r.blocks||[])if(typeof block.ja==='string'&&!r.blockEls?.has(block)){
      if(!block.colors){cachedPixels??=readPagePixels(r);block.colors=pickColors(r,cachedPixels,block);}
      fillBlock(blockElement(r,block),block,block.ja);
    }
    for (const [block, el] of r.blockEls || []) if (block.ja?.includes('<m_')) renderRuns(el, block.ja, block);
    r.sourceText ??= createSourceTextLayer(r, pdfjsLib.TextLayer, document);
    // Text extraction failure must not hide an otherwise readable PDF.
    try { await r.sourceText.render(); } catch (error) { console.error('原文の選択用テキストを読み込めませんでした', error); }
    if(state.settings.geminiKey)getPageBlocks(r).catch(console.error);
  })();
  return r.renderP;
}

function releasePage(r) {
  if (r.busy) return; // 翻訳中のページは画像を使うので残す
  r.renderVersion = (r.renderVersion || 0) + 1;
  r.renderTask?.cancel();
  r.sourceText?.release();
  for (const box of [r.left, r.right]) {
    const c = box.querySelector(':scope > canvas');
    if (c) { c.width = c.height = 0; c.remove(); }
  }
  r.srcCanvas = null;
  r.renderP = null;
  r.renderScale = 0;
}

// ---------- レイアウト解析（文字 → 行 → ブロック） ----------
function getPageBlocks(r) {
  // 全文を先に読む場合も、フォント情報を読み込んでから段落を判定する。
  return loadTranslationBlocks(r, state.rows, row => row.page.getOperatorList().then(operators => extractBlocks(row, operators)));
}

// ---------- 色の推定（背景色と文字色をページ画像から拾う） ----------
// Readback uses a temporary CPU-oriented surface; display canvases stay optimized
// for rendering and zoom. Release the temporary bitmap after copying its pixels.
function readPagePixels(r) {
  const source=r.srcCanvas,copy=document.createElement('canvas');
  copy.width=source.width;copy.height=source.height;
  try {
    const context=copy.getContext('2d',{willReadFrequently:true});
    context.drawImage(source,0,0);
    return context.getImageData(0,0,copy.width,copy.height);
  } finally { copy.width=copy.height=0; }
}

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
  el.onmouseenter = () => { hot(true); showTools(el); };
  el.onmouseleave = () => { hot(false); hideToolsSoon(); };
  return el;
}

// 原文の選択レイヤーがマウスを受け取り、下の枠は選択を遮らず強調表示だけ行う。
function trackSourceHover(r) {
  let hovered = null,point=null;
  const set = (next,source) => {
    if (next === hovered){if(next?._b&&source!==toolsOnSource)showTools(next,source);return;}
    hovered?._hot(false);
    hovered = next;
    hovered?._hot(true);
    if(next?._b)showTools(next,source);else if(!next)hideToolsSoon();
  };
  const move=(box,source)=>(event)=>{
    if(event.target?.closest?.('.blk-tools'))return;
    const rect = box.getBoundingClientRect();
    const x = (event.clientX - rect.left) * r.vp.width / rect.width;
    const y = (event.clientY - rect.top) * r.vp.height / rect.height;
    const current=point={x,y,source};
    const pick=()=>{
      if(point!==current)return;
      const block=(r.blocks||[...(r.blockEls?.keys()||[])]).find(b=>b.translate!==false&&x>=b.x0-1.5&&x<=b.x1+1.5&&y>=b.top-1.5&&y<=b.bottom+1.5);
      let el=block&&r.blockEls?.get(block);
      if(block&&!el&&state.settings.geminiKey){el=blockElement(r,block);el.classList.remove('pending');el.classList.add('untranslated');}
      set(el||null,source);
    };
    if(r.blocks||r.blockEls?.size||!state.settings.geminiKey)pick();else getPageBlocks(r).then(pick).catch(console.error);
  };
  r.left.onpointermove=move(r.left,true);
  if(r.right)r.right.onpointermove=move(r.right,false);
  r.left.onpointerleave=()=>{point=null;set(null);};
  if(r.right)r.right.onpointerleave=()=>{point=null;set(null);};
}

function blockElement(r, b) {
  r.blockEls ??= new Map();
  let el = r.blockEls.get(b);
  if (!el) { el = placeBlock(r, b); r.blockEls.set(b, el); }
  el._row = r;
  return el;
}

function fillBlock(el, b, text) {
  b.ja = text; // PDF保存用に覚えておく
  el.title = '';
  el.classList.remove('pending');
  el.classList.remove('untranslated');
  el.classList.add(b.bold ? 'bold' : b.sans ? 'sans' : 'serif');
  el.style.textAlign = b.align;
  el.style.background = `rgb(${b.colors.bg})`;
  el.style.color = `rgb(${b.colors.fg})`;
  el.classList.toggle('off', !!b.hidden);
  renderRuns(el, text, b);
  fitText(el, b);
}

// 訳せなかった段落：訳を重ねず原文を見せる。マウスを乗せると「訳し直す」が出る
function markFailed(el, b) {
  b.failed = true;
  el.classList.remove('pending');
  el.classList.add('off');
}

// 訳文を描く。$…$ の数式は記号に直し、下付き・上付きは小さい文字にする
function renderRuns(el, text, block) {
  const nodes = [];
  for (const part of protectedRuns(text, block?.mathSpans)) {
    if (part.math) {
      const span = part.math, img = document.createElement('img');
      img.className = 'protected-math';
      img.src = mathImage(el._row, span, document);
      img.alt = span.text; img.title = '原文の数式: ' + span.text;
      img.style.width = (span.x1 - span.x0) / span.h + 'em';
      img.style.height = (span.bottom - span.top) / span.h + 'em';
      img.style.verticalAlign = -(span.bottom - span.base) / span.h + 'em';
      nodes.push(img); continue;
    }
    nodes.push(...toRuns(part.text).map((run) => {
      if (!run.s) return document.createTextNode(run.t);
      const e = document.createElement(run.s); // <sub> / <sup>
      e.textContent = run.t;
      return e;
    }));
  }
  el.replaceChildren(...nodes);
}

// ---------- 段落ごとの操作（訳し直す・原文を見る） ----------
const tools = document.createElement('div');
tools.className = 'blk-tools';
const redoBtn = document.createElement('button');
redoBtn.textContent = '↻ 訳し直す';
redoBtn.title = 'この段落だけ、もう一度翻訳します';
const toggleBtn = document.createElement('button');
const blockGeminiBtn=document.createElement('button');
blockGeminiBtn.textContent='Geminiで翻訳';
tools.append(redoBtn,blockGeminiBtn,toggleBtn);
let toolsFor = null;
let toolsOnSource=false;
let hideTimer = 0;

function showTools(el,onSource=false) {
  clearTimeout(hideTimer);
  const b = el._b;
  const canGemini=!!state.settings.geminiKey?.trim()&&b.translate!==false&&state.engine!=='gemini';
  if (el.classList.contains('pending')&&!canGemini) { tools.remove(); return; }
  toolsFor = el;
  toolsOnSource=onSource;
  const key=JSON.stringify([state.settings.geminiModel||'',srcSel.value,dstSel.value]);
  const cached=b.geminiTranslation?.key===key&&b.ja===b.geminiTranslation.text;
  const active=blockGeminiJob?.blocks.has(b);
  blockGeminiBtn.hidden=!canGemini;
  blockGeminiBtn.disabled=state.exporting||srcSel.value===dstSel.value||!!blockGeminiJob&&!active;
  blockGeminiBtn.textContent=active?'Geminiを中断':cached?'Geminiで訳し直す':'Geminiで翻訳';
  blockGeminiBtn.setAttribute('aria-busy',String(!!active));
  blockGeminiBtn.title=active?'この段落のGemini翻訳を中断します':'全文を文脈として添え、この段落だけをGeminiで翻訳します';
  // Chrome内蔵は何度訳しても同じ結果になるので、訳し直しは Gemini のときだけ
  redoBtn.hidden = (b.hidden && !b.failed) || state.engine !== 'gemini' || (state.translator?.ready && !state.translator.completed);
  toggleBtn.hidden = !!b.failed||typeof b.ja!=='string'||el.classList.contains('pending');
  toggleBtn.textContent = b.hidden ? '訳を表示' : '原文を表示';
  toggleBtn.title = b.hidden ? 'この段落の訳を元に戻します' : 'この段落の訳を消して、原文が見えるようにします';
  // 段落の右上（枠のすぐ外）に置く。ページの上端に近いときは枠の内側
  const top = parseFloat(el.style.top);
  tools.style.top = (top >= 20 ? top - 20 : top) + 'px';
  tools.style.left = parseFloat(el.style.left) + parseFloat(el.style.width) + 'px';
  (onSource?el._row.srcLayer:el.parentNode).appendChild(tools);
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
  showTools(el,toolsOnSource);
};
redoBtn.onclick = () => { if (toolsFor) redoBlock(toolsFor); };
blockGeminiBtn.onclick=()=>{
  if(blockGeminiJob?.blocks.has(toolsFor?._b)){cancelBlockGemini();setStatus('この段落のGemini翻訳を中断しました');return;}
  if(toolsFor)return translateBlockWithGemini(toolsFor);
};

function cancelBlockGemini(){
  const job=blockGeminiJob;if(!job)return;
  blockGeminiJob=null;job.controller.abort();
  if(job.version===state.translationVersion){
    const entries=[];
    for(const [block,text]of job.localResults){block.ja=text;entries.push({block,row:state.rows.find(r=>r.blocks?.includes(block)),text});}
    displayCommittedTranslations(entries).catch(console.error);
  }
  if(toolsFor)showTools(toolsFor,toolsOnSource);
}

async function translateBlockWithGemini(el){
  const b=el._b,{geminiKey,geminiModel}=state.settings,sourceLanguage=srcSel.value,targetLanguage=dstSel.value;
  if(!geminiKey?.trim()||state.exporting||blockGeminiJob||state.engine==='gemini'||b.translate===false||sourceLanguage===targetLanguage)return;
  const cacheKey=JSON.stringify([geminiModel||'',sourceLanguage,targetLanguage]);
  const force=b.geminiTranslation?.key===cacheKey&&b.ja===b.geminiTranslation.text;
  const job={controller:new AbortController(),version:state.translationVersion,blocks:new Set([b]),localResults:new Map(),hidden:b.hidden};
  blockGeminiJob=job;if(toolsFor)showTools(toolsFor,toolsOnSource);
  const active=()=>blockGeminiJob===job&&job.version===state.translationVersion&&!job.controller.signal.aborted
    &&srcSel.value===sourceLanguage&&dstSel.value===targetLanguage&&state.settings.geminiKey===geminiKey&&state.settings.geminiModel===geminiModel;
  try{
    const scope=createDocumentTranslator({rows:state.rows,getBlocks:getPageBlocks,signal:job.controller.signal,
      getCached:block=>block.geminiTranslation?.key===cacheKey?block.geminiTranslation.text:undefined,
      onProgress:message=>{if(active())setStatus('この段落のGemini翻訳: '+message);},
      translator:createGeminiTranslator({apiKey:geminiKey,model:geminiModel,sourceLanguage,targetLanguage,signal:job.controller.signal,
        onWait:message=>{if(active())setStatus(message);}})});
    const updates=await scope.translateSelectedBlocks(b,blocks=>{job.blocks=new Set(blocks);},{force});
    if(!active())return;
    const entries=[];
    for(const [block,text]of updates){
      if(typeof text!=='string')continue;
      block.geminiTranslation={key:cacheKey,text};block.geminiOverrideVersion=job.version;block.ja=text;block.failed=false;
      if(block===b&&block.hidden===job.hidden)block.hidden=false;
      const row=state.rows.find(r=>r.blocks?.includes(block));(row.previousTranslations??=new Map()).set(block,text);
      entries.push({block,row,text});
    }
    await displayCommittedTranslations(entries);
    if(active())setStatus('この段落のGemini翻訳が完了しました');
  }catch(error){
    if(active()){
      cancelBlockGemini();setStatus('この段落のGemini翻訳に失敗しました: '+error.message);
    }
  }finally{
    if(blockGeminiJob===job){blockGeminiJob=null;if(toolsFor)showTools(toolsFor,toolsOnSource);}
  }
}

async function redoBlock(el) {
  const b = el._b, tr = state.translator;
  if (!tr || el.classList.contains('pending')) return;
  tools.remove();
  el.classList.add('pending');
  const finish = beginTranslation();
  try {
    const updates = tr.retranslateBlocks ? await tr.retranslateBlocks(b) : new Map([[b, await tr.retranslateBlock(b)]]);
    if (tr !== state.translator) return;
    for (const [block, text] of updates) {
      const row = state.rows.find((r) => r.blocks?.includes(block));
      if (!row) continue;
      if (block.failed) { block.failed = false; block.hidden = false; }
      fillBlock(block === b ? el : blockElement(row, block), block, text);
    }
  } catch (e) {
    if (tr !== state.translator) return;
    console.error(e);
    setStatus('訳し直しに失敗しました: ' + e.message);
  } finally {
    if (tr === state.translator) el.classList.remove('pending');
    finish();
  }
}

// ---------- 翻訳 ----------
function translationBusy() {
  return [...translationActivities].some((activity) => activity.version === state.translationVersion);
}

function stopTranslation(announce = true) {
  cancelBlockGemini();
  ++state.translationVersion;
  state.enabled = false;
  state.queue = [];
  state.working = false;
  translationActivities.clear();
  if (state.translator?.ready && !state.translator.completed) clearTranslationPreviews();
  state.translator = null;
  state.preparingAbort?.abort();
  state.translationAbort?.abort();
  state.preparingAbort = state.translationAbort = null;
  for (const row of state.rows) {
    row.queued = false;
    row.busy = false;
    for (const [block, el] of row.blockEls || []) if (el.classList.contains('pending')) {
      if (typeof block.ja === 'string') fillBlock(el, block, block.ja);
      else { el._src?.remove(); el.remove(); row.blockEls.delete(block); }
    }
    for (const el of row.dstLayer.querySelectorAll('.page-msg')) el.remove();
    if (!row.visible) releasePage(row);
  }
  tools.remove(); toolsFor = null;
  updateStartButton();
  if (announce) setStatus('翻訳を中断しました。完了した訳文は保持しています');
}

function chooseTranslation(engine) {
  autoTranslatePending = false;
  if (state.exporting) return;
  if (translationBusy()) {
    const stopOnly = state.engine === engine;
    stopTranslation(stopOnly);
    if (stopOnly) return;
  }
  return start(engine);
}

function completionMessage(translator) {
  return translator.originalCount
    ? `翻訳が完了しました（数式の読み取りが不確かな${translator.originalCount}ブロックは原文で保持）`
    : '全文の翻訳が完了しました';
}

async function start(engine = state.engine) {
  if (state.exporting) { setStatus('PDFの保存が終わってから翻訳を切り替えてください'); return; }
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
  cancelBlockGemini();
  const version = ++state.translationVersion;
  const controller = new AbortController();
  state.preparingAbort?.abort();
  state.preparingAbort = controller;
  state.engine = engine;

  const finish = beginTranslation();
  let prepared = false;
  try {
    let translator;
    if (engine === 'gemini') {
      const onProgress = (message) => { if (version === state.translationVersion) setStatus(message); };
      const cacheKey=JSON.stringify([geminiModel||'',sourceLanguage,targetLanguage]);
      translator = createDocumentTranslator({
        rows: state.rows,
        getBlocks: getPageBlocks,
        getCached: b=>b.geminiTranslation?.key===cacheKey?b.geminiTranslation.text:undefined,
        onCommit: entries=>{
          if(translator!==state.translator)return;
          for(const {block:b,row,text}of entries)if(typeof text==='string'){
            b.geminiTranslation={key:cacheKey,text};b.ja=text;
            (row.previousTranslations??=new Map()).set(b,text);
          }
          displayCommittedTranslations(entries).catch(console.error);
        },
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
      translator = await createChromeTranslator(sourceLanguage, targetLanguage, controller.signal);
      if (!translator) return; // 理由はステータスに表示済み
    }
    if (version !== state.translationVersion) return;
    // 切替先の準備が成功するまでは、既存の翻訳結果を使えるようにしておく。
    // 未検証のGeminiプレビューは、切替前の有効な訳へ戻してから引き継ぐ。
    if (state.translator?.ready && !state.translator.completed) clearTranslationPreviews();
    const pair = `${sourceLanguage}:${targetLanguage}`;
    const preserve = state.translationPair === pair && state.rows.some((r) => r.blocks?.some((b) => typeof b.ja === 'string'));
    state.translationAbort?.abort();
    state.translationAbort = controller;
    state.translator = translator;
    state.translationPair = pair;
    prepared = true;
    tools.remove();
    toolsFor = null;

    state.queue = [];
    for (const r of state.rows) {
      r.translated = false;
      r.queued = false;
      r.failed = false;
      r.previewEls = new Map();
      r.previousTranslations = preserve
        ? new Map((r.blocks || []).filter((b) => typeof b.ja === 'string').map((b) => [b, b.ja]))
        : null;
      if (!preserve) {
        // A selected Gemini request can finish while the local model prepares.
        // Keep only results produced for this run; older language pairs reset.
        const selected=new Set((r.blocks||[]).filter(b=>b.geminiOverrideVersion===version&&typeof b.ja==='string'));
        for (const b of r.blocks || []) if(!selected.has(b)) b.ja = null;
        if(selected.size){
          for(const [b,el]of r.blockEls||[])if(!selected.has(b)){el._src?.remove();el.remove();r.blockEls.delete(b);}
        }else{
          r.blockEls = new Map();
          r.srcLayer.replaceChildren();
          r.dstLayer.replaceChildren();
        }
      }
      for (const el of r.dstLayer.querySelectorAll('.page-msg')) el.remove();
    }
    state.enabled = true;
    setStatus('翻訳中…');
    if (translator.ready) {
      const finishDocument = beginTranslation();
      translator.ready().then(() => {
        if (translator === state.translator) setStatus(completionMessage(translator));
      }).catch((e) => {
        if (translator === state.translator) setStatus('全文の翻訳に失敗しました: ' + e.message);
      }).finally(finishDocument);
    }
    enqueueVisiblePages();
  } catch (e) {
    if (version === state.translationVersion) setStatus('翻訳の準備に失敗しました: ' + e.message);
  } finally {
    if (state.preparingAbort === controller) state.preparingAbort = null;
    if (!prepared) {
      controller.abort();
      if (version === state.translationVersion) state.engine = previousEngine;
    }
    finish();
  }
}

// Chrome内蔵の Translator API（1段落ずつ順に訳す）
async function createChromeTranslator(sourceLanguage, targetLanguage, signal) {
  if (!('Translator' in self)) {
    setStatus('このChromeはTranslator API未対応です（Chrome 138以降が必要）');
    return null;
  }
  try {
    const avail = await Translator.availability({ sourceLanguage, targetLanguage });
    signal?.throwIfAborted();
    if (avail === 'unavailable') { setStatus(`${sourceLanguage}→${targetLanguage} は未対応の組み合わせです`); return null; }
    setStatus(avail === 'available' ? '準備中…' : '翻訳モデルをダウンロード中…');
    const tr = await Translator.create({
      sourceLanguage,
      targetLanguage,
      signal,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          if (!signal?.aborted) setStatus(`翻訳モデルをダウンロード中… ${Math.round(e.loaded * 100)}%`);
        });
      },
    });
    const destroy = () => tr.destroy?.();
    if (signal?.aborted) { destroy(); return null; }
    signal?.addEventListener('abort', destroy, { once: true });
    return {
      async translateBatch(texts, onEach) {
        for (let i = 0; i < texts.length; i++) {
          signal?.throwIfAborted();
          const text = await tr.translate(texts[i], { signal });
          signal?.throwIfAborted();
          if (onEach(i, text) === false) return;
        }
      },
    };
  } catch (e) {
    if (signal?.aborted) return null;
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
  if (!state.enabled || !state.translator) return;
  if (r.queued || r.translated) return;
  r.queued = true;
  r.failed = false;
  state.queue.push(r);
  pump();
}

async function pump() {
  if (state.working?.version === state.translationVersion) return;
  const job = { version: state.translationVersion };
  state.working = job;
  let error = null;
  let errorTranslator = null;
  while (state.queue.length && state.working === job && state.enabled) {
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
  if (state.working !== job) return;
  state.working = false;
  if(blockGeminiJob)return;
  if (error && errorTranslator === state.translator && state.rows.some((r) => r.failed)) setStatus('翻訳エラー: ' + error.message);
  else if (!state.exporting) setStatus(state.translator.ready
    ? completionMessage(state.translator) : '先読み範囲の翻訳が完了しました');
}

// 訳せなかった段落は原文の表示に戻し、ページの上にエラーと「再試行」ボタンを出す
function showPageError(r, e) {
  for (const [b, el] of r.blockEls || []) if (el.classList.contains('pending')) {
    el._src?.remove(); el.remove(); r.blockEls.delete(b);
  }
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
  if (translator.missingCount) retry.title = '全文を文脈として添え、不足分だけを翻訳します。対象が多い場合は複数回に分けて送信します。';
  retry.onclick = () => {
    if (translator !== state.translator) return;
    if (translator.missingCount) return repairMissingTranslations();
    msg.remove();
    return translator.ready ? start() : enqueue(r);
  };
  msg.append(retry);
  if (translator.issues?.length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `問題の${translator.issues.length}ブロックを確認`;
    details.append(summary);
    const reasons = { citation: '参照番号が原文と不一致', unchanged: '原文のまま未翻訳', missing: '訳文が未受信', pending: '関連ブロックが未受信', request: 'API呼び出しが未完了' };
    for (const issue of translator.issues) {
      const item = document.createElement('div');
      const jump = document.createElement('button');
      jump.textContent = `${issue.page}ページ・対象ブロック${issue.block}へ移動`;
      jump.onclick = () => goToPage(issue.page);
      const reason = document.createElement('p');
      reason.textContent = reasons[issue.reason] || '検証に失敗';
      const source = document.createElement('p');
      source.textContent = '原文: ' + issue.source;
      const translated = document.createElement('p');
      translated.textContent = '検証で保留した訳文: ' + (issue.translated || '（未受信）');
      item.append(jump, reason, source, translated);
      details.append(item);
    }
    msg.append(details);
  }
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
    setStatus(completionMessage(translator));
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
  const job = {};
  r.busy = job;
  try {
    await translatePageInner(r, translator);
  } finally {
    if (r.busy === job) {
      r.busy = false;
      if (!r.visible) releasePage(r);
    }
  }
}

// 新しい訳が届くまでは、既存の訳（なければ原文）を残す。
async function displayCommittedTranslations(entries){
  const rows=new Set(entries.map(e=>e.row).filter(r=>r?.visible));
  for(const row of rows){
    await renderPage(row);
    if(!row.visible)continue;
    let pixels;
    for(const {block,text,row:entryRow}of entries)if(entryRow===row&&typeof text==='string'&&block.ja===text){
      if(!block.colors){pixels??=readPagePixels(row);block.colors=pickColors(row,pixels,block);}
      fillBlock(blockElement(row,block),block,text);
    }
  }
}

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
      pix ??= readPagePixels(r);
      b.colors = pickColors(r, pix, b);
    }
    if (!el) { el = blockElement(r, b); r.previewEls.set(b, el); }
    fillBlock(el, b, text);
  }
}

function clearTranslationPreviews() {
  for (const r of state.rows) {
    for (const [b, el] of r.previewEls || []) {
      const previous = r.previousTranslations?.get(b);
      if (previous !== undefined) {
        fillBlock(el, b, previous);
      } else {
        el._src?.remove();
        el.remove();
        r.blockEls?.delete(b);
        b.ja = null;
      }
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
    const pix = readPagePixels(r);
    for (const b of r.blocks) if (b.translate) b.colors = pickColors(r, pix, b);
  }
  if (translator !== state.translator) return; // 待っている間にやり直された
  for (const b of r.blocks) b.failed = false;
  for (const el of r.dstLayer.querySelectorAll('.page-msg')) el.remove();

  const targets = r.blocks.filter((b) => b.translate);
  if (!targets.length) {
    // Bibliographies and figure-only pages intentionally keep their originals.
    if(!r.blocks.some(b=>b.translationSkip)){
      const msg = document.createElement('div');
      msg.className = 'page-msg';
      msg.textContent = '翻訳するテキストがありません（画像だけのページかもしれません）';
      r.dstLayer.appendChild(msg);
    }
    r.translated = true;
    return;
  }

  const els = targets.map((b) => blockElement(r, b));
  const onEach = (i, text, detail) => {
    if (translator !== state.translator) return false; // 言語や設定を切り替えられた
    if(state.engine==='chrome'){
      const block=targets[i];
      if(block.geminiOverrideVersion===state.translationVersion)return;
      if(blockGeminiJob?.version===state.translationVersion&&blockGeminiJob.blocks.has(block)){
        if(typeof text==='string')blockGeminiJob.localResults.set(block,text);
        return;
      }
    }
    if (detail?.original) {
      targets[i].ja = null;
      markFailed(els[i], targets[i]);
      els[i].title = '数式の読み取りが不確かなため原文で保持しています';
      return;
    }
    if (text == null) {
      if (typeof targets[i].ja !== 'string') markFailed(els[i], targets[i]);
      return; // 以前の訳があれば残し、なければ原文を見せる。
    }
    fillBlock(els[i], targets[i], text);
  };
  if (translator.translatePage) await translator.translatePage(r, onEach);
  else await translator.translateBatch(targets.map((b) => b.text), onEach);
  if (translator !== state.translator) return;
  r.translated = true;
  r.previewEls?.clear();
  r.previousTranslations = null;
}

// ---------- PDFとして保存 ----------
function canExportTranslation() {
  return !blockGeminiJob&&state.enabled && !state.translator?.missingCount
    && (!state.translator?.ready || state.translator.completed)
    && state.rows.some((r) => r.translated && r.blocks?.some((b) => b.ja));
}

function closeDownloadMenu() {
  $('#downloadMenu').hidden = true;
  $('#download').setAttribute('aria-expanded', 'false');
}

function toggleDownloadMenu() {
  closeViewerMenu();
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
  updateStartButton();
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
    updateStartButton();
    btn.disabled = false;
  }
}

// まだ訳していないページもすべて訳し終わるまで待つ
async function translateAll() {
  const translator = state.translator;
  if (!translator || !state.enabled) throw new Error('翻訳が中断されています。翻訳を開始してください');
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
  cancelBlockGemini();
  state.settings = next;
  if(toolsFor)showTools(toolsFor,toolsOnSource);
}

// 翻訳はいらないとき：このPDFだけ、いつものビューアで開き直す
async function openNativeViewer() {
  if (pdfSource.fallback) {
    // Falling back can unload just the handler frame, so restore tab zoom explicitly.
    await self.chrome?.tabs?.setZoomSettings?.(pdfSource.tabId, { mode: 'automatic', scope: 'per-origin' }).catch(() => {});
    await pdfSource.fallback();
    return;
  }
  const tab = await chrome.tabs.getCurrent();
  await chrome.runtime.sendMessage({ type: 'openOriginal', tabId: tab.id, url: fileUrl });
}
function closeViewerMenu() {
  $('#viewerMenu').hidden = true;
  $('#openOriginal').setAttribute('aria-expanded', 'false');
}
async function openViewerDestination(destination) {
  closeViewerMenu();
  try {
    const tab = pdfSource.tabId !== undefined ? { id: pdfSource.tabId } : await chrome.tabs.getCurrent();
    const frame = chrome.webNavigation?.getFrame
      ? await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }).catch(() => null) : tab;
    const address = frame?.url?.split('#')[0] === fileUrl.split('#')[0] ? frame.url : fileUrl;
    const reply = await chrome.runtime.sendMessage({
      type: 'openOriginal', tabId: tab.id, url: viewerDestinationUrl(address, destination), reload: !!pdfSource.fallback, handoff: !!pdfSource.fallback,
    });
    if (!reply?.ok) throw new Error(reply?.error || '切り替えを開始できませんでした');
    if(reply.handoff)await openNativeViewer();
  } catch (error) { setStatus('ビューアへの切り替えに失敗しました: ' + error.message); }
}
if (fileUrl && self.chrome?.tabs) {
  $('#openOriginal').hidden = false;
  $('#openOriginal').onclick = () => {
    closeDownloadMenu();
    const menu = $('#viewerMenu');
    menu.hidden = !menu.hidden;
    $('#openOriginal').setAttribute('aria-expanded', String(!menu.hidden));
  };
}
$('#openNormalViewer').onclick = () => openViewerDestination('normal');
$('#openChromeViewer').onclick = () => openViewerDestination('chrome');
self.chrome?.runtime?.onMessage?.addListener((message, _sender, reply) => {
  if (message.type === 'getViewerState') reply({ fileUrl, mime: !!pdfSource.fallback });
  if (message.type === 'openNativeViewer') {
    // A successful handoff destroys this frame. Acknowledge acceptance first,
    // otherwise the popup waits on a message port that can no longer reply.
    reply({ ok: true });
    openNativeViewer().catch((error) => {
      console.error(error);
      setStatus('通常のビューアへの切り替えに失敗しました: ' + error.message);
    });
  }
});

$('#startLocal').onclick = () => chooseTranslation('chrome');
$('#startGemini').onclick = () => chooseTranslation('gemini');
$('#openSettings').onclick = showSettings;
$('#download').onclick = toggleDownloadMenu;
$('#downloadOriginal').onclick = () => download('orig');
$('#downloadTranslated').onclick = () => download('ja');
$('#downloadBoth').onclick = () => download('both');
citationDialog = createCitationDialog({
  document, fileUrl, getPdf: () => state.pdf,
  download: (text, filename) => saveFile(new TextEncoder().encode(text), filename, 'text/plain;charset=utf-8'),
});
$('#cite').onclick = () => { closeDownloadMenu(); closeViewerMenu(); return citationDialog.open(); };
window.addEventListener('pointerdown', (e) => {
  if (!$('#downloadMenu').hidden && !e.target?.closest?.('.download-control')) closeDownloadMenu();
  if (!$('#viewerMenu').hidden && !e.target?.closest?.('.viewer-choice-control')) closeViewerMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDownloadMenu(); closeViewerMenu(); }
  handleZoomKey(e);
});
srcSel.onchange = dstSel.onchange = () => {
  cancelBlockGemini();
  if(state.enabled||state.preparingAbort){
    const engine=state.engine;
    stopTranslation(false);
    start(engine);
  }
};

if (!pdfSource.nativeFallback) disableNativeZoom(self.chrome?.tabs, pdfSource.tabId).catch(() => {});

load();
