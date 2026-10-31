import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createGeminiTranslator } from '../gemini.js';
import { createDocumentTranslator } from '../document-translator.js';

const viewerSource = await readFile(new URL('../viewer.js', import.meta.url), 'utf8');
const element = () => {
  const classes = new Set(), attributes = new Map();
  return {
    value: '', style: { setProperty() {} },
    children: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    prepend(child) { child.parent = this; this.children.unshift(child); },
    replaceWith(next) {
      const index = this.parent.children.indexOf(this);
      this.parent.children[index] = next;
      next.parent = this.parent;
    },
    querySelector() { return this.children.find((child) => child.tagName === 'canvas') || null; },
    append() {}, appendChild() {}, replaceChildren() {}, remove() {}, querySelectorAll: () => [],
  };
};
async function viewer(engine = 'gemini', localTranslator = {}, nextSettings = null) {
  const elements = new Map();
  const createdElements = [];
  const listeners = new Map(), resizeObservers = [];
  const pageFrames = [], scrollCalls = [];
  const savedFiles = [];
  let nextFrame = 0;
  const document = {
    body: { dataset: {} }, documentElement: { scrollHeight: 1000, clientHeight: 900, style: { setProperty() {} } },
    querySelector: (name) => { if (!elements.has(name)) elements.set(name, element()); return elements.get(name); },
    createElement: (tagName) => {
      const el = element();
      el.tagName = tagName;
      createdElements.push(el);
      if (tagName === 'canvas') el.getContext = () => ({ drawImage() {} });
      return el;
    },
  };
  const window = { addEventListener: (event, callback) => listeners.set(event, callback) }; window.top = window;
  const context = {
    document, window, createdElements, savedFiles, self: {}, location: { search: '' },
    scrollCalls,
    dispatchResize: () => listeners.get('resize')?.(),
    dispatchScroll: () => listeners.get('scroll')?.(),
    dispatchKey: (event) => listeners.get('keydown')?.(event),
    dispatchWheel: (event) => listeners.get('wheel')?.(event),
    dispatchPageFrames: () => pageFrames.splice(0).forEach((callback) => callback()),
    requestAnimationFrame: (callback) => { pageFrames.push(callback); return ++nextFrame; },
    dispatchHeaderResize: () => resizeObservers.forEach((callback) => callback()),
    getComputedStyle: (el) => el.computedStyle,
    ResizeObserver: class { constructor(callback) { resizeObservers.push(callback); } observe() {} },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ addEventListener() {} }), devicePixelRatio: 1, scrollY: 0,
    scrollTo(x, y) { scrollCalls.push([x, y]); context.scrollY = y; },
    AbortController, URL, setTimeout, clearTimeout, console: { error() {} },
    pdfjsLib: { GlobalWorkerOptions: {} },
    createGeminiTranslator, createDocumentTranslator,
    createNativeZoom: async () => null,
    createCitationDialog: () => ({ open() {}, position() {} }),
    loadSettings: async () => ({ engine, geminiKey: 'mock-key', geminiModel: 'gemini-3.5-flash-lite' }),
    openSettings: async () => nextSettings,
    Translator: {
      availability: async () => 'available',
      create: async () => ({ translate: async (text) => 'ローカル訳: ' + text }),
      ...localTranslator,
    },
  };
  context.self.Translator = context.Translator;
  // Run the actual viewer orchestration. Only PDF/canvas/DOM rendering is replaced.
  const source = viewerSource.replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../viewer.js', import.meta.url).href)).replace(/\nload\(\);\s*$/, `
    const rendering = { pixelScale, makeCanvas, renderPage, releasePage, viewZoom };
    renderPage = async () => {};
    getPageBlocks = async (r) => r.blocks;
    releasePage = () => {};
    placeBlock = () => elementStub();
    fillBlock = (_el, b, text) => { b.ja = text; };
    saveFile = (bytes, name) => { savedFiles.push({bytes, name}); };
    return { state, start, enqueue, translateAll, createdElements, savedFiles, document, element: $, resize: dispatchResize, headerResize: dispatchHeaderResize, scroll: dispatchScroll, key: dispatchKey, wheel: dispatchWheel, flushPageFrames: dispatchPageFrames, scrollCalls, scrollY: () => scrollY, goToPage, updatePageNavigation, status: () => $('#status').textContent, startButton: $('#startGemini'), localButton: $('#startLocal'), settingsButton: $('#openSettings'), beginTranslation, rendering, window, viewSelect: viewSel };
  `);
  context.elementStub = element;
  const api = await vm.runInNewContext('(async () => {' + source + '})()', context);
  api.state.pdf = {};
  api.state.rows = [1, 2, 3].map((index) => ({
    index, visible: index === 1, srcLayer: element(), dstLayer: element(),
    blocks: [{ text: `Paragraph on page ${index}`, translate: true, colors: {} }],
  }));
  api.updatePageNavigation();
  api.element('#downloadMenu').hidden = true;
  return api;
}
async function idle(api) {
  for (let i = 0; i < 100; i++) {
    await new Promise(setImmediate);
    if (!api.state.working) return;
  }
  assert.fail('viewer queue did not become idle');
}
function success(input) {
  return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{
    type: 'text', text: JSON.stringify({ translations: input.pages.flatMap((p) => p.blocks.filter((b) => b.translate_id !== undefined).map((b) => ({ id: b.translate_id, text: '訳文 ' + b.translate_id }))) }),
  }] }] });
}

test('viewer translates all pages on start and renders unseen pages for export without another request', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const input = JSON.parse(JSON.parse(init.body).input); requests.push(input); return success(input);
  });
  const api = await viewer();
  await api.start('gemini');
  await idle(api);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pages.length, 3);
  assert.equal(requests[0].translate_count, 3);
  assert.equal(api.state.rows[0].blocks[0].ja, '訳文 1');
  assert.ok(!api.state.rows[2].translated);
  await api.translateAll();
  assert.equal(requests.length, 1);
  assert.ok(api.state.rows.every((r) => r.translated));
  assert.equal(api.state.rows[2].blocks[0].ja, '訳文 3');
});

test('viewer preserves Chrome local per-page translation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not use API'));
  const api = await viewer('chrome');
  await api.start('chrome');
  await idle(api);
  assert.equal(api.state.rows[0].blocks[0].ja, 'ローカル訳: Paragraph on page 1');
  assert.ok(!api.state.rows[2].translated);
  await api.translateAll();
  assert.ok(api.state.rows.every((r) => r.translated));
});

test('separate buttons choose local or Gemini regardless of the legacy saved engine', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; return success(JSON.parse(JSON.parse(init.body).input));
  });
  const api = await viewer('gemini');
  await api.localButton.onclick();
  await idle(api);
  assert.equal(calls, 0);
  assert.equal(api.state.engine, 'chrome');
  assert.equal(api.state.rows[0].blocks[0].ja, 'ローカル訳: Paragraph on page 1');
  await api.startButton.onclick();
  await idle(api);
  assert.equal(calls, 1);
  assert.equal(api.state.engine, 'gemini');
  assert.equal(api.state.rows[0].blocks[0].ja, '訳文 1');
  await api.localButton.onclick();
  await idle(api);
  assert.equal(calls, 1);
  assert.equal(api.state.engine, 'chrome');
  assert.equal(api.state.rows[0].blocks[0].ja, 'ローカル訳: Paragraph on page 1');
});

test('missing Gemini key does not prevent local translation or choose an engine automatically', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not use API'));
  const api = await viewer('gemini');
  api.state.settings.geminiKey = '';
  await api.start();
  assert.equal(api.state.engine, null);
  assert.match(api.status(), /翻訳ボタンを選んで/);
  await api.startButton.onclick();
  assert.match(api.status(), /APIキーを入力/);
  assert.equal(api.state.engine, null);
  await api.localButton.onclick();
  await idle(api);
  assert.equal(api.state.engine, 'chrome');
  assert.equal(api.state.rows[0].blocks[0].ja, 'ローカル訳: Paragraph on page 1');
});

test('local preparation shows its own spinner and disables both buttons', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = await viewer('gemini', { availability: async () => { await gate; return 'available'; } });
  const pending = api.localButton.onclick();
  assert.equal(api.localButton.textContent, '翻訳中…');
  assert.equal(api.localButton.getAttribute('aria-busy'), 'true');
  assert.ok(api.localButton.classList.contains('loading'));
  assert.equal(api.localButton.disabled, true);
  assert.equal(api.startButton.disabled, true);
  assert.equal(api.startButton.getAttribute('aria-busy'), 'false');
  assert.ok(!api.startButton.classList.contains('loading'));
  release();
  await pending;
  await idle(api);
  assert.equal(api.localButton.textContent, 'ローカルAI');
  assert.equal(api.localButton.disabled, false);
  assert.equal(api.startButton.disabled, false);
});

test('saving Gemini settings does not start a request or switch local translation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not use API'));
  const api = await viewer('chrome', {}, { geminiKey: 'new-mock-key', geminiModel: 'another-model' });
  await api.localButton.onclick();
  await idle(api);
  await api.settingsButton.onclick();
  assert.equal(api.state.engine, 'chrome');
  assert.equal(api.state.settings.geminiModel, 'another-model');
});

test('failed local switch preserves the existing Gemini result for unseen pages and export', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; return success(JSON.parse(JSON.parse(init.body).input));
  });
  const api = await viewer('gemini', { availability: async () => 'unavailable' });
  await api.startButton.onclick();
  await idle(api);
  await api.localButton.onclick();
  assert.match(api.status(), /未対応/);
  assert.equal(api.state.engine, 'gemini');
  assert.equal(api.state.translationAbort.signal.aborted, false);
  await api.translateAll();
  assert.ok(api.state.rows.every((r) => r.translated));
  assert.equal(calls, 1);
});

test('viewer rejects incomplete output and export without additional requests', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; return Response.json({ status: 'incomplete', steps: [] });
  });
  const api = await viewer();
  await api.start('gemini');
  await idle(api);
  assert.equal(calls, 1);
  assert.ok(api.state.rows[0].failed);
  assert.ok(api.state.rows.every((r) => !r.translated && !r.blocks[0].ja));
  await assert.rejects(api.translateAll());
  assert.equal(calls, 1);
  assert.match(api.status(), /失敗|エラー/);
  assert.equal(api.startButton.disabled, false);
  assert.equal(api.startButton.getAttribute('aria-busy'), 'false');
});

test('missing-only retry button repairs one paragraph and reuses the full result for export', async (t) => {
  let calls = 0, release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const repairStarted = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const input = JSON.parse(JSON.parse(init.body).input);
    calls++;
    if (calls === 2) { started(); await gate; }
    const translations = input.pages.flatMap((p) => p.blocks
      .filter((b) => b.translate_id !== undefined && (calls > 1 || b.translate_id !== 2))
      .map((b) => ({ id: b.translate_id, text: calls === 1 ? '初回訳 ' + b.translate_id : '補完した訳文' })));
    return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ translations }) }] }] });
  });
  const api = await viewer();
  await api.startButton.onclick();
  await idle(api);
  assert.equal(calls, 1);
  assert.equal(api.state.translator.missingCount, 1);
  assert.ok(api.state.rows.every((r) => !r.blocks[0].ja));
  await assert.rejects(api.translateAll());
  assert.equal(calls, 1);
  const retry = api.createdElements.find((e) => e.textContent === '不足1段落だけ再翻訳');
  assert.ok(retry);
  const repairing = retry.onclick();
  await retry.onclick(); // A second click cannot start another request.
  await repairStarted;
  assert.equal(calls, 2);
  assert.equal(api.startButton.getAttribute('aria-busy'), 'true');
  release();
  await repairing;
  await idle(api);
  await api.translateAll();
  assert.deepEqual(api.state.rows.map((r) => r.blocks[0].ja), ['初回訳 1', '補完した訳文', '初回訳 3']);
  assert.equal(calls, 2);
  assert.equal(api.state.translator.missingCount, 0);
  assert.equal(api.startButton.disabled, false);
});

test('restart aborts the old request and only displays the new result', async (t) => {
  let calls = 0, started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const input = JSON.parse(JSON.parse(init.body).input);
    calls++;
    if (calls === 1) {
      started();
      await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    return success(input);
  });
  const api = await viewer();
  await api.start('gemini');
  await firstStarted;
  await api.start('gemini');
  await idle(api);
  assert.equal(calls, 2);
  assert.equal(api.state.rows[0].blocks[0].ja, '訳文 1');
  assert.ok(!api.state.rows[0].failed);
  assert.equal(api.status(), '全文の翻訳が完了しました');
});

test('start button stays busy during the full request and returns to normal on completion', async (t) => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    started();
    await gate;
    return success(JSON.parse(JSON.parse(init.body).input));
  });
  const api = await viewer();
  await api.start('gemini');
  await requestStarted;
  assert.equal(api.startButton.disabled, true);
  assert.equal(api.startButton.textContent, '翻訳中…');
  assert.ok(api.startButton.classList.contains('loading'));
  assert.equal(api.startButton.getAttribute('aria-busy'), 'true');
  assert.equal(api.localButton.disabled, true);
  assert.equal(api.localButton.getAttribute('aria-busy'), 'false');
  assert.ok(!api.localButton.classList.contains('loading'));
  release();
  await idle(api);
  assert.equal(api.startButton.disabled, false);
  assert.equal(api.startButton.textContent, 'Gemini');
  assert.ok(!api.startButton.classList.contains('loading'));
  assert.equal(api.localButton.disabled, false);
});

test('failed local translator preparation releases the start button', async () => {
  const api = await viewer('chrome', { availability: async () => 'unavailable' });
  await api.start('chrome');
  assert.match(api.status(), /未対応/);
  assert.equal(api.startButton.disabled, false);
  assert.equal(api.startButton.getAttribute('aria-busy'), 'false');
});

test('completion of an older task cannot clear the current loading indicator', async () => {
  const api = await viewer();
  api.state.engine = 'gemini';
  const finishOld = api.beginTranslation();
  api.state.translationVersion++;
  const finishNew = api.beginTranslation();
  finishOld();
  assert.equal(api.startButton.disabled, true);
  finishNew();
  assert.equal(api.startButton.disabled, false);
});

test('both PDF canvases render above display density and rerender after zooming', async () => {
  const api = await viewer();
  const renders = [];
  const r = {
    vp: { width: 800, height: 1100 }, left: element(), right: element(),
    page: { render: (options) => { renders.push(options); return { promise: Promise.resolve() }; } },
  };
  api.window.devicePixelRatio = 1;
  await api.rendering.renderPage(r);
  assert.equal(r.srcCanvas.width, 1200);
  assert.equal(r.srcCanvas.height, 1650);
  assert.equal(r.srcCanvas.style.width, '800px');
  assert.equal(r.left.children[0].width, r.right.children[0].width);
  assert.equal(r.left.children[0].height, r.right.children[0].height);
  assert.equal(renders[0].transform[0], 1.5);
  await api.rendering.renderPage(r);
  assert.equal(renders.length, 1);

  api.state.zoom = 1.25;
  await api.rendering.renderPage(r);
  assert.equal(renders.length, 2);
  assert.equal(r.srcCanvas.width, 1500);
  assert.equal(r.srcCanvas.height, 2062);
  assert.equal(r.srcCanvas.style.width, '800px');
});

test('high DPI and single-page display increase density while respecting the canvas budget', async () => {
  const api = await viewer();
  const r = { vp: { width: 800, height: 1100 } };
  api.window.devicePixelRatio = 2;
  assert.equal(api.rendering.pixelScale(r), 3);
  api.viewSelect.value = 'orig';
  api.state.fit = 2;
  assert.equal(api.rendering.pixelScale({ vp: { width: 200, height: 300 } }), 6);
  api.viewSelect.value = 'both';
  api.state.zoom = 3;
  const scale = api.rendering.pixelScale(r);
  assert.ok(scale < 9);
  const canvas = api.rendering.makeCanvas(r.vp, scale);
  assert.ok(canvas.width * canvas.height <= 2 ** 24);
});

function fitFixture(api) {
  const pages = api.element('#pages'), header = api.element('header');
  pages.clientWidth = 1200;
  pages.computedStyle = { paddingLeft: '14px', paddingRight: '14px', paddingTop: '12px' };
  header.height = 60;
  header.getBoundingClientRect = () => ({ top: 0, bottom: header.height, height: header.height });
  api.element('#pageNumber').select = () => {};
  api.element('#pageNumber').blur = () => {
    api.document.activeElement = null;
    api.element('#pageNumber').onblur();
  };
  for (const [i, row] of api.state.rows.entries()) {
    row.vp = { width: 500, height: 700 };
    for (const [side, visible] of [['left', 'orig'], ['right', 'ja']]) {
      row[side] = { getBoundingClientRect: () => api.document.body.dataset.view === (visible === 'orig' ? 'ja' : 'orig')
        ? { top: 0, bottom: 0, height: 0 }
        : { top: 80 + i * 720 - api.scrollY(), bottom: 780 + i * 720 - api.scrollY(), height: 700 } };
    }
  }
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('width fit accounts for two pages and their gap, and follows single-side view changes', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('zoom must not call translation API'));
  const api = await viewer();
  fitFixture(api);
  api.element('#fitWidth').onclick();
  near(api.rendering.viewZoom() * (500 * 2 + 12), 1200 - 28);
  assert.equal(api.element('#fitWidth').getAttribute('aria-pressed'), 'true');
  assert.equal(api.element('#fitHeight').getAttribute('aria-pressed'), 'false');
  api.viewSelect.value = 'orig';
  api.viewSelect.onchange();
  near(api.rendering.viewZoom() * 500, 1200 - 28);
  api.viewSelect.value = 'ja'; // The left page was visible before this change.
  api.viewSelect.onchange();
  near(api.rendering.viewZoom() * 500, 1200 - 28);
  api.element('#pages').clientWidth = 1600;
  api.resize();
  near(api.rendering.viewZoom() * 500, 1600 - 28);
});

test('height fit uses the page at the viewport and subtracts toolbar and margins', async () => {
  const api = await viewer();
  fitFixture(api);
  api.state.rows[0].left.getBoundingClientRect = () => ({ top: -800, bottom: -100 });
  api.state.rows[1].left.getBoundingClientRect = () => ({ top: -90, bottom: 910 });
  api.state.rows[1].vp.height = 1000;
  api.element('#fitHeight').onclick();
  near(api.rendering.viewZoom() * 1000, 900 - 60 - 24);
  assert.equal(api.element('#fitHeight').getAttribute('aria-pressed'), 'true');
  api.element('header').height = 120;
  api.headerResize();
  near(api.rendering.viewZoom() * 1000, 900 - 120 - 24);
  api.document.documentElement.clientHeight = 600;
  api.resize();
  near(api.rendering.viewZoom() * 1000, 600 - 120 - 24);
});

test('manual zoom exits fit mode and steps to the nearest preset from a fractional fit', async () => {
  const api = await viewer();
  fitFixture(api);
  api.document.documentElement.clientHeight = 588; // (588 - 60 - 24) / 700 = 72%.
  api.element('#fitHeight').onclick();
  near(api.state.zoom, 0.72);
  api.element('#zoomIn').onclick();
  near(api.state.zoom, 0.75);
  assert.equal(api.state.fitMode, null);
  assert.equal(api.element('#fitHeight').getAttribute('aria-pressed'), 'false');
  api.resize();
  near(api.state.zoom, 0.75);
  api.element('#fitHeight').onclick();
  api.element('#zoomOut').onclick();
  near(api.state.zoom, 0.67);
  api.element('#fitWidth').onclick();
  api.element('#zoomReset').onclick();
  assert.equal(api.state.zoom, 1);
  assert.equal(api.state.fitMode, null);
  assert.equal(api.element('#zoomLabel').textContent, '100%');
});

test('page arrows and page input move through the original PDF page numbers without translation requests', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('navigation must not call translation API'));
  const api = await viewer();
  fitFixture(api);
  const input = api.element('#pageNumber');
  assert.equal(input.value, '1');
  assert.equal(api.element('#pageTotal').textContent, '3');
  assert.equal(api.element('#prevPage').disabled, true);
  api.element('#nextPage').onclick();
  assert.equal(api.state.currentPage, 2);
  near(api.scrollCalls.at(-1)[1], 800 - 60 - 12);
  assert.equal(input.value, '2');
  api.element('#prevPage').onclick();
  assert.equal(api.state.currentPage, 1);
  api.document.activeElement = input;
  input.value = '3';
  input.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.equal(api.state.currentPage, 3);
  assert.equal(api.element('#nextPage').disabled, true);
  input.value = '999';
  input.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.equal(input.value, '3');
  const scrolls = api.scrollCalls.length;
  for (const value of ['', 'abc', '1.5']) {
    input.value = value;
    input.onkeydown({ key: 'Enter', preventDefault() {} });
    assert.equal(input.value, '3');
  }
  input.value = '1';
  input.onkeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(input.value, '3');
  assert.equal(api.scrollCalls.length, scrolls);
  api.viewSelect.value = 'ja';
  api.viewSelect.onchange();
  api.goToPage(2); // The hidden original page must not be used for scrolling.
  near(api.scrollCalls.at(-1)[1], 800 - 60 - 12);
});

test('page counter follows the most visible page while preserving an input being edited', async () => {
  const api = await viewer();
  fitFixture(api);
  // Move page 1 behind the toolbar and show most of page 2.
  api.state.rows[0].left.getBoundingClientRect = () => ({ top: -660, bottom: 40 });
  api.state.rows[1].left.getBoundingClientRect = () => ({ top: 60, bottom: 760 });
  api.state.rows[2].left.getBoundingClientRect = () => ({ top: 780, bottom: 1480 });
  api.scroll();
  api.scroll();
  api.flushPageFrames();
  assert.equal(api.state.currentPage, 2);
  assert.equal(api.element('#pageNumber').value, '2');
  const input = api.element('#pageNumber');
  api.document.activeElement = input;
  input.value = '1';
  api.state.rows[1].left.getBoundingClientRect = () => ({ top: -660, bottom: 40 });
  api.state.rows[2].left.getBoundingClientRect = () => ({ top: 60, bottom: 760 });
  api.scroll();
  api.flushPageFrames();
  assert.equal(api.state.currentPage, 3);
  assert.equal(input.value, '1');
  input.blur();
  assert.equal(input.value, '3');
});

test('page navigation keeps height fit when the destination page has a different size', async () => {
  const api = await viewer();
  fitFixture(api);
  api.state.rows[1].vp.height = 1000;
  api.element('#fitHeight').onclick();
  api.element('#nextPage').onclick();
  assert.equal(api.state.currentPage, 2);
  assert.equal(api.state.fitMode, 'height');
  near(api.rendering.viewZoom() * 1000, 900 - 60 - 24);
  api.state.pdf = null;
  api.state.rows = [];
  api.updatePageNavigation();
  assert.equal(api.element('#pageNumber').disabled, true);
  assert.equal(api.element('#prevPage').disabled, true);
  assert.equal(api.element('#nextPage').disabled, true);
  assert.equal(api.goToPage(1), false);
});

test('download menu offers the original only before translation and saves its exact bytes', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('saving must not start translation'));
  const api = await viewer();
  const bytes = new Uint8Array([37, 80, 68, 70]);
  api.state.pdf.getData = async () => bytes;
  api.state.name = 'paper.pdf';
  api.element('#download').onclick();
  assert.equal(api.element('#downloadMenu').hidden, false);
  assert.equal(api.element('#downloadOriginal').disabled, false);
  assert.equal(api.element('#downloadTranslated').disabled, true);
  assert.equal(api.element('#downloadBoth').disabled, true);
  await api.element('#downloadTranslated').onclick();
  assert.equal(api.savedFiles.length, 0);
  await api.element('#downloadBoth').onclick();
  assert.equal(api.savedFiles.length, 0);
  await api.element('#downloadOriginal').onclick();
  assert.equal(api.savedFiles.length, 1);
  assert.equal(api.savedFiles[0].bytes, bytes);
  assert.equal(api.savedFiles[0].name, 'paper.pdf');
  assert.equal(api.element('#downloadMenu').hidden, true);
  assert.equal(api.state.enabled, false);
});

test('translated download choices become available after local translation', async () => {
  const api = await viewer();
  await api.localButton.onclick();
  await idle(api);
  api.element('#download').onclick();
  assert.equal(api.element('#downloadOriginal').disabled, false);
  assert.equal(api.element('#downloadTranslated').disabled, false);
  assert.equal(api.element('#downloadBoth').disabled, false);
});

test('missing Gemini output does not enable translated downloads or resend on save', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"translations":[{"id":1,"text":"訳文"}]}' }] }] });
  });
  const api = await viewer();
  await api.startButton.onclick();
  await idle(api);
  api.element('#download').onclick();
  assert.equal(api.element('#downloadTranslated').disabled, true);
  assert.equal(api.element('#downloadBoth').disabled, true);
  await api.element('#downloadBoth').onclick();
  assert.equal(calls, 1);
  assert.equal(api.savedFiles.length, 0);
});

test('keyboard shortcuts and pinch adjust PDF zoom while leaving the toolbar size unchanged', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('zoom must not call translation API'));
  const api = await viewer();
  fitFixture(api);
  let prevented = 0;
  const event = (key, modifiers = {}) => ({ key, ctrlKey: true, preventDefault: () => { prevented++; }, ...modifiers });
  api.key(event('+'));
  near(api.state.zoom, 1.1);
  assert.equal(api.element('#zoomLabel').textContent, '110%');
  api.key(event('-', { ctrlKey: false, metaKey: true }));
  near(api.state.zoom, 1);
  api.wheel({ ctrlKey: true, deltaY: -100, deltaMode: 0, preventDefault: () => { prevented++; } });
  api.flushPageFrames();
  near(api.state.zoom, Math.exp(0.2));
  assert.equal(api.element('#zoomLabel').textContent, '122%');
  api.key(event('0'));
  assert.equal(api.state.zoom, 1);
  assert.equal(api.element('header').height, 60);
  api.key(event('+', { target: { closest: () => true } }));
  assert.equal(api.state.zoom, 1);
  assert.equal(prevented, 5);
});
