import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createGeminiTranslator } from '../gemini.js';
import { createDocumentTranslator } from '../document-translator.js';
import { disableNativeZoom } from '../native-zoom.js';
import { createPdfLoadProgress } from '../pdf-load-progress.js';
import { horizontalZoomShift, verticalZoomShift } from '../zoom-anchor.js';
import { resolvePdfSource } from '../pdf-source.js';
import { streamFixture, until } from './helpers/stream.mjs';

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
    removeAttribute: (name) => attributes.delete(name),
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
async function viewer(engine = 'gemini', localTranslator = {}, nextSettings = null, savedZoom = 1, sourceOverride = null) {
  const elements = new Map();
  const createdElements = [];
  const listeners = new Map(), resizeObservers = [];
  const pageFrames = new Map(), scrollCalls = [], zoomSaves = [];
  const savedFiles = [];
  const placedBlocks = [];
  const nativeZoomCalls = [];
  const sourceTextCalls = [];
  const tabs = {
    getCurrent: async () => ({ id: 42 }),
    setZoomSettings: async (id, settings) => { nativeZoomCalls.push({ id, ...settings }); },
    setZoom: () => assert.fail('PDF zoom must not set Chrome zoom or open its popover'),
  };
  let nextFrame = 0;
  const rootStyles = new Map();
  const document = {
    body: { dataset: {} }, documentElement: { scrollHeight: 1000, clientHeight: 900, clientWidth: 1200, style: {
      setProperty: (name, value) => rootStyles.set(name, value), getPropertyValue: (name) => rootStyles.get(name),
    } },
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
    document, window, createdElements, savedFiles, placedBlocks, self: { chrome: { tabs,
      runtime: { onMessage: { addListener: (callback) => listeners.set('runtimeMessage', callback) } },
    } }, location: { search: '' },
    scrollCalls,
    dispatchResize: () => listeners.get('resize')?.(),
    dispatchScroll: () => listeners.get('scroll')?.(),
    dispatchKey: (event) => listeners.get('keydown')?.(event),
    dispatchWheel: (event) => listeners.get('wheel')?.(event),
    dispatchRuntimeMessage: (...args) => listeners.get('runtimeMessage')?.(...args),
    dispatchPageFrames: () => { const callbacks = [...pageFrames.values()]; pageFrames.clear(); callbacks.forEach((callback) => callback()); },
    requestAnimationFrame: (callback) => { pageFrames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => pageFrames.delete(id),
    dispatchHeaderResize: () => resizeObservers.forEach((callback) => callback()),
    getComputedStyle: (el) => el.computedStyle,
    ResizeObserver: class { constructor(callback) { resizeObservers.push(callback); } observe() {} },
    IntersectionObserver: class { observe() {} },
    localStorage: { getItem: (name) => name === 'zoom' ? String(savedZoom) : null, setItem(name, value) { if (name === 'zoom') zoomSaves.push(value); } },
    matchMedia: () => ({ addEventListener() {} }), devicePixelRatio: 1, scrollY: 0,
    scrollTo(x, y) { scrollCalls.push([x, y]); context.scrollY = y; window.scrollX = x; },
    AbortController, URL, setTimeout, clearTimeout, console: { error() {} },
    pdfjsLib: { GlobalWorkerOptions: {} },
    createSourceTextLayer: (row) => {
      sourceTextCalls.push(['create', row]);
      return { render: async () => { sourceTextCalls.push(['render', row]); },
        release: () => { sourceTextCalls.push(['release', row]); } };
    },
    createGeminiTranslator, createDocumentTranslator,
    resolvePdfSource: sourceOverride ? async () => sourceOverride : resolvePdfSource,
    disableNativeZoom, createPdfLoadProgress, horizontalZoomShift, verticalZoomShift,
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
    const rendering = { pixelScale, makeCanvas, renderPage, releasePage, viewZoom, trackSourceHover,
      enable() { renderPage = rendering.renderPage; releasePage = rendering.releasePage; } };
    renderPage = async () => {};
    getPageBlocks = async (r) => r.blocks;
    releasePage = () => {};
    placeBlock = (r, b) => {
      const el = elementStub();
      el._b = b;
      el.classList.add('pending');
      el.remove = () => { el.removed = true; };
      placedBlocks.push({ row: r, block: b, el });
      return el;
    };
    fillBlock = (el, b, text) => { b.ja = text; el.textContent = text; el.classList.remove('pending'); };
    saveFile = (bytes, name) => { savedFiles.push({bytes, name}); };
    return { state, buildRows, autoTranslateOnOpen, start, enqueue, enqueueVisiblePages, translateAll, createdElements, savedFiles, document, element: $, resize: dispatchResize, headerResize: dispatchHeaderResize, scroll: dispatchScroll, key: dispatchKey, wheel: dispatchWheel, flushPageFrames: dispatchPageFrames, scrollCalls, scrollY: () => scrollY, goToPage, updatePageNavigation, status: () => $('#status').textContent, startButton: $('#startGemini'), localButton: $('#startLocal'), settingsButton: $('#openSettings'), beginTranslation, finishZoomGesture, rendering, window, viewSelect: viewSel };
  `);
  context.elementStub = element;
  const api = await vm.runInNewContext('(async () => {' + source + '})()', context);
  api.placedBlocks = placedBlocks;
  api.nativeZoomCalls = nativeZoomCalls;
  api.sourceTextCalls = sourceTextCalls;
  api.zoomSaves = zoomSaves;
  api.runtimeMessage = context.dispatchRuntimeMessage;
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
  assert.equal(requests[0].targets, undefined); // Failed separated input is not the viewer default.
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
  assert.ok(api.state.rows[2].translated);
  await api.translateAll();
  assert.ok(api.state.rows.every((r) => r.translated));
});

function localPages(api, count) {
  api.state.rows = Array.from({ length: count }, (_, i) => ({
    index: i + 1, visible: i === 0, srcLayer: element(), dstLayer: element(),
    blocks: [{ text: `Page ${i + 1}`, translate: true, colors: {} }],
  }));
}

test('local AI translates fifteen pages ahead, advances on scrolling and reuses translated pages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('local lookahead must not call Gemini'));
  const calls = [];
  const api = await viewer('chrome', { create: async () => ({ translate: async (text) => { calls.push(text); return '訳 ' + text; } }) });
  localPages(api, 30);
  await api.start('chrome');
  await idle(api);
  assert.deepEqual(calls, Array.from({ length: 16 }, (_, i) => `Page ${i + 1}`));
  assert.equal(api.state.rows[15].translated, true);
  assert.ok(!api.state.rows[16].translated);
  for (const r of api.state.rows) r.visible = r.index === 10;
  api.enqueueVisiblePages();
  await idle(api);
  assert.deepEqual(calls.slice(16), Array.from({ length: 9 }, (_, i) => `Page ${i + 17}`));
  assert.ok(!api.state.rows[25].translated);
  for (const r of api.state.rows) r.visible = r.index === 30;
  api.enqueueVisiblePages();
  await idle(api);
  assert.equal(calls.at(-1), 'Page 30');
  assert.equal(calls.length, 26); // No read-ahead beyond the final page.
  for (const r of api.state.rows) r.visible = r.index === 1;
  api.enqueueVisiblePages();
  await idle(api);
  assert.equal(calls.length, 26);
});

test('newly visible local pages take priority over queued lookahead after a jump', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const api = await viewer('chrome', { create: async () => ({ translate: async (text) => {
    calls.push(text);
    if (calls.length === 1) await gate;
    return '訳 ' + text;
  } }) });
  localPages(api, 40);
  await api.start('chrome');
  for (let i = 0; i < 10 && !calls.length; i++) await new Promise(setImmediate);
  assert.deepEqual(calls, ['Page 1']);
  for (const r of api.state.rows) r.visible = r.index === 20;
  api.enqueueVisiblePages();
  release();
  await idle(api);
  assert.equal(calls[1], 'Page 20');
  assert.deepEqual(calls.slice(1, 17), Array.from({ length: 16 }, (_, i) => `Page ${i + 20}`));
  assert.equal(new Set(calls).size, calls.length);
  assert.ok(!api.state.rows[35].translated);
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
  assert.equal(api.sourceTextCalls.filter(([op]) => op === 'create').length, 1);
  assert.equal(api.sourceTextCalls.filter(([op]) => op === 'render').length, 2);
  api.rendering.releasePage(r);
  assert.equal(api.sourceTextCalls.at(-1)[0], 'release');
});

test('source text can receive pointer events while block hover follows zoomed page coordinates', async () => {
  const api = await viewer(), changes = [];
  const a = { x0: 10, x1: 100, top: 20, bottom: 80 };
  const b = { x0: 10, x1: 100, top: 100, bottom: 180 };
  const row = { left: element(), vp: { width: 500, height: 700 },
    blockEls: new Map([[a, { _hot: (on) => changes.push(['a', on]) }], [b, { _hot: (on) => changes.push(['b', on]) }]]) };
  row.left.getBoundingClientRect = () => ({ left: -40, top: 60, width: 1000, height: 1400 });
  api.rendering.trackSourceHover(row);
  const move = (x, y) => row.left.onpointermove({ clientX: -40 + x * 2, clientY: 60 + y * 2,
    preventDefault: () => assert.fail('must preserve native text selection') });
  move(30, 40); move(30, 45); move(30, 140);
  row.left.onpointerleave();
  assert.deepEqual(changes, [['a', true], ['a', false], ['b', true], ['b', false]]);
});

test('native viewer handoff replies before the receiving MIME frame can be destroyed', async () => {
  const order = [];
  let complete;
  const gate = new Promise((resolve) => { complete = resolve; });
  const api = await viewer('gemini', {}, null, 1, {
    originalUrl: 'https://arxiv.org/pdf/2301.08243', tabId: 42,
    fallback: async () => { order.push('frame handoff'); await gate; },
  });
  const result = api.runtimeMessage({ type: 'openNativeViewer' }, {}, (reply) => {
    assert.equal(reply.ok, true); order.push('accepted');
  });
  assert.equal(result, undefined); // No asynchronous message port to outlive the frame.
  assert.deepEqual(order, ['accepted']);
  await until(() => order.length === 2);
  assert.deepEqual(order, ['accepted', 'frame handoff']);
  assert.deepEqual(api.nativeZoomCalls.at(-1), { id: 42, mode: 'automatic', scope: 'per-origin' });
  complete();
});

test('a rejected native handoff reports its error in the surviving viewer after acknowledgement', async () => {
  const api = await viewer('gemini', {}, null, 1, {
    originalUrl: 'https://arxiv.org/pdf/2301.08243', tabId: 42,
    fallback: async () => { throw new Error('handoff failed'); },
  });
  let acknowledged = false;
  api.runtimeMessage({ type: 'openNativeViewer' }, {}, () => { acknowledged = true; });
  assert.equal(acknowledged, true);
  await until(() => (api.status() || '').includes('handoff failed'));
  assert.match(api.status(), /通常のビューアへの切り替えに失敗/);
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
  pages.getBoundingClientRect = () => ({ left: -(api.window.scrollX || 0), top: 60 - api.scrollY(), width: 1200, height: 2200 });
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
  assert.equal(api.document.documentElement.style.getPropertyValue('--toolbar-height'), '120px');
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
  near(api.state.zoom, Math.exp(0.7));
  assert.equal(api.element('#zoomLabel').textContent, '201%');
  api.key(event('0'));
  assert.equal(api.state.zoom, 1);
  assert.equal(api.element('header').height, 60);
  api.key(event('+', { target: { closest: () => true } }));
  assert.equal(api.state.zoom, 1);
  assert.equal(prevented, 5);
  api.element('#zoomIn').onclick();
  api.element('#zoomOut').onclick();
  api.element('#zoomReset').onclick();
  assert.deepEqual(api.nativeZoomCalls, [{ id: 42, mode: 'disabled', scope: 'per-tab' }]);
});

test('pinching only transforms the existing page until idle, then renders once and preserves the pointer anchor', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('pinch must not call translation API'));
  const api = await viewer();
  fitFixture(api);
  api.document.documentElement.clientWidth = 450;
  api.viewSelect.value = 'orig';
  api.document.body.dataset.view = 'orig';
  api.state.fit = 1;
  api.rendering.enable();
  let renders = 0, geometryReads = 0;
  const left = element(), right = element();
  left.getBoundingClientRect = () => {
    geometryReads++;
    const scale = Number(api.document.documentElement.style.getPropertyValue('--zoom'));
    return { left: 14 - (api.window.scrollX || 0), top: 72 - api.scrollY(), width: 500 * scale, height: 700 * scale };
  };
  const row = { index: 1, visible: true, left, right, vp: { width: 500, height: 700 }, page: {
    render: () => { renders++; return { promise: Promise.resolve() }; },
  } };
  api.state.rows = [row];
  await api.rendering.renderPage(row);
  api.flushPageFrames();
  const saves = api.zoomSaves.length, scrolls = api.scrollCalls.length;
  const before = left.getBoundingClientRect(), clientX = 250, clientY = 300;
  const anchorX = (clientX - before.left) / before.width, anchorY = (clientY - before.top) / before.height;
  const target = { closest: (selector) => selector === '.page' ? left : null };
  api.wheel({ ctrlKey: true, deltaY: -10, deltaMode: 0, clientX, clientY, target, preventDefault() {} });
  api.flushPageFrames();
  const reads = geometryReads;
  for (let i = 0; i < 20; i++) {
    api.wheel({ ctrlKey: true, deltaY: -2, deltaMode: 0, clientX, clientY, target, preventDefault() {} });
    api.flushPageFrames();
  }
  assert.equal(renders, 1); // No PDF rendering during the gesture.
  assert.equal(geometryReads, reads); // No per-frame page geometry reads.
  assert.equal(api.zoomSaves.length, saves);
  assert.equal(api.scrollCalls.length, scrolls);
  assert.match(api.element('#pages').style.transform, /^translate\(.+px, .+px\) scale\(/);
  assert.equal(api.element('#pages').classList.contains('zoom-preview'), true);
  assert.equal(api.document.documentElement.style.getPropertyValue('--zoom'), 1);
  near(api.state.zoom, Math.exp(0.35));
  await new Promise((resolve) => setTimeout(resolve, 190)); // Verify automatic idle completion.
  assert.equal(renders, 2);
  assert.equal(api.element('#pages').style.transform, '');
  assert.equal(api.element('#pages').classList.contains('zoom-preview'), false);
  assert.equal(api.zoomSaves.length, saves + 1);
  assert.equal(api.scrollCalls.length, scrolls + 1);
  const after = left.getBoundingClientRect();
  near(after.left + after.width * anchorX, clientX);
  near(after.top + after.height * anchorY, clientY);
  assert.ok(row.srcCanvas.width > 750);
});

test('superseded PDF renders are cancelled and old waiters receive the latest canvas', async () => {
  const api = await viewer(), tasks = [];
  const row = { visible: true, vp: { width: 500, height: 700 }, left: element(), right: element(), page: {
    render: () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const task = { promise, resolve, cancelled: false, cancel() {
        this.cancelled = true;
        const error = new Error('cancelled'); error.name = 'RenderingCancelledException'; reject(error);
      } };
      tasks.push(task);
      return task;
    },
  } };
  const first = api.rendering.renderPage(row);
  api.state.zoom = 2;
  const latest = api.rendering.renderPage(row);
  assert.equal(tasks[0].cancelled, true);
  tasks[1].resolve();
  await Promise.all([first, latest]);
  assert.equal(row.srcCanvas.width, 1500);
  assert.equal(row.left.children.length, 1);
  assert.equal(api.createdElements.filter((el) => el.tagName === 'canvas')[0].width, 0);
});

test('a render interrupted by pinching waits for gesture completion instead of failing translation', async () => {
  const api = await viewer(), tasks = [];
  fitFixture(api);
  api.rendering.enable();
  const row = { index: 1, visible: true, busy: true, vp: { width: 500, height: 700 }, left: element(), right: element(), page: {
    render: () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const task = { promise, resolve, cancel() { const e = new Error('cancelled'); e.name = 'RenderingCancelledException'; reject(e); } };
      tasks.push(task); return task;
    },
  } };
  row.left.getBoundingClientRect = () => ({left:14,top:72,width:500,height:700,bottom:772});
  row.right.getBoundingClientRect = () => ({left:526,top:72,width:500,height:700,bottom:772});
  api.state.rows = [row];
  const pending = api.rendering.renderPage(row);
  api.wheel({ ctrlKey: true, deltaY: -50, deltaMode: 0, preventDefault() {} });
  api.flushPageFrames();
  await new Promise(setImmediate);
  assert.equal(tasks.length, 1);
  api.finishZoomGesture();
  await until(() => tasks.length === 2);
  tasks[1].resolve();
  await pending;
  assert.ok(row.srcCanvas.width > 750);
});

test('Gemini streams completed paragraphs while unfinished paragraphs stay English and export stays disabled', async (t) => {
  const f = streamFixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.equal(request.stream, true);
    assert.equal(JSON.parse(request.input).pages.length, 3);
    return f.response;
  });
  const api = await viewer();
  api.state.rows[0].blocks.push({ text: 'Another paragraph', translate: true, colors: {} });
  await api.startButton.onclick();
  await until(() => calls === 1);
  f.start();
  f.text('{"translations":[{"id":1,"text":"未完');
  await new Promise(setImmediate);
  assert.equal(api.placedBlocks.length, 0); // No overlay: the original PDF remains visible.
  assert.equal(api.state.rows[0].blocks[0].ja, null);
  f.text('成ではなく完成した訳"},');
  await until(() => api.state.rows[0].blocks[0].ja);
  assert.equal(api.placedBlocks.length, 1);
  assert.equal(api.state.rows[0].blocks[1].ja, null);
  assert.equal(api.state.rows[0].translated, false);
  assert.equal(api.startButton.getAttribute('aria-busy'), 'true');
  api.element('#download').onclick();
  assert.equal(api.element('#downloadOriginal').disabled, false);
  assert.equal(api.element('#downloadTranslated').disabled, true);
  assert.equal(api.element('#downloadBoth').disabled, true);
  await api.element('#downloadTranslated').onclick();
  assert.equal(api.savedFiles.length, 0);
  assert.equal(calls, 1);
  // Scroll to another page before the full request completes.
  for (const row of api.state.rows) row.visible = row.index === 2;
  api.enqueueVisiblePages();
  f.text('{"id":3,"text":"移動先の訳"},');
  await until(() => api.state.rows[1].blocks[0].ja === '移動先の訳');
  assert.equal(api.state.rows[1].translated, false);
  f.text('{"id":2,"text":"次の段落"},{"id":4,"text":"最終ページ"}]}');
  await new Promise(setImmediate);
  assert.equal(api.state.translator.completed, false);
  assert.equal(api.startButton.getAttribute('aria-busy'), 'true');
  f.complete();
  await idle(api);
  await api.translateAll();
  assert.equal(api.state.translator.completed, true);
  assert.ok(api.state.rows.every((row) => row.translated));
  assert.equal(api.state.rows[0].blocks[1].ja, '次の段落');
  assert.equal(api.state.rows[2].blocks[0].ja, '最終ページ');
  assert.equal(api.startButton.getAttribute('aria-busy'), 'false');
  api.element('#download').onclick();
  assert.equal(api.element('#downloadTranslated').disabled, false);
  assert.equal(calls, 1);
});

test('invalid final Gemini stream removes provisional overlays and cannot enable translated export or resend', async (t) => {
  const f = streamFixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return f.response; });
  const api = await viewer();
  await api.startButton.onclick();
  f.start();
  f.text('{"translations":[{"id":1,"text":"暫定訳"},');
  await until(() => api.state.rows[0].blocks[0].ja === '暫定訳');
  const provisional = api.placedBlocks[0].el;
  f.text('{"id":1,"text":"重複した訳"}]}');
  f.complete();
  await idle(api);
  assert.equal(api.state.translator.completed, false);
  assert.equal(api.state.rows[0].blocks[0].ja, null);
  assert.equal(provisional.removed, true);
  assert.ok(api.state.rows.every((r) => !r.translated));
  assert.match(api.status(), /重複/);
  api.element('#download').onclick();
  assert.equal(api.element('#downloadTranslated').disabled, true);
  await api.element('#downloadTranslated').onclick();
  assert.equal(api.savedFiles.length, 0);
  assert.equal(calls, 1);
});

test('restarting streamed translation cancels its reader and clears old provisional translations', async (t) => {
  const old = streamFixture(), next = streamFixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => (++calls === 1 ? old.response : next.response));
  const api = await viewer();
  await api.start('gemini');
  old.start();
  old.text('{"translations":[{"id":1,"text":"古い暫定訳"},');
  await until(() => api.state.rows[0].blocks[0].ja === '古い暫定訳');
  await api.start('gemini');
  await until(() => old.cancelled);
  assert.equal(api.state.rows[0].blocks[0].ja, null);
  next.start();
  next.text('{"translations":[{"id":1,"text":"新しい訳"},{"id":2,"text":"新しい訳2"},{"id":3,"text":"新しい訳3"}]}');
  next.complete();
  await idle(api);
  assert.equal(api.state.rows[0].blocks[0].ja, '新しい訳');
  assert.equal(api.state.translator.completed, true);
  assert.equal(calls, 2);
  assert.equal(api.startButton.getAttribute('aria-busy'), 'false');
});

test('centered and pointer-based zoom previews match the final layout without a horizontal snap', async (t) => {
  for (const scenario of [
    { name: 'margins remain', initial: 1, target: 1.25, scroll: 0 },
    { name: 'cross into overflow', initial: 1, target: 1.9, scroll: 0 },
    { name: 'shrink back into margins', initial: 2, target: 1.2, scroll: 200 },
    { name: 'already overflowing', initial: 2, target: 2.5, scroll: 200 },
    { name: 'pointer in the side margin', initial: 1, target: 1.9, scroll: 0, pointer: 980 },
  ]) await t.test(scenario.name, async () => {
    const api = await viewer();
    fitFixture(api);
    api.document.documentElement.clientWidth = 1000;
    const pages = api.element('#pages');
    pages.clientWidth = 1000;
    pages.getBoundingClientRect = () => ({left: -(api.window.scrollX || 0), top:60-api.scrollY(), width:1000, height:2200});
    api.viewSelect.value = 'orig';
    api.document.body.dataset.view = 'orig';
    api.state.fit = 1;
    api.state.zoom = scenario.initial;
    api.document.documentElement.style.setProperty('--zoom', scenario.initial);
    api.window.scrollX = scenario.scroll;
    const left = element(), right = element(), rowElement = element();
    left.getBoundingClientRect = () => {
      const scale = Number(api.document.documentElement.style.getPropertyValue('--zoom'));
      const width = 600 * scale, height = 800 * scale, top = 72 - api.scrollY();
      return {left:14+(parseFloat(rowElement.style.width)*scale-width)/2-(api.window.scrollX || 0),top,width,height,bottom:top+height};
    };
    api.state.rows = [{index:1,element:rowElement,visible:true,left,right,vp:{width:600,height:800}}];
    api.resize();
    const before = left.getBoundingClientRect(), clientX = scenario.pointer || 750, clientY = 350;
    const x = (clientX-before.left)/before.width, y = (clientY-before.top)/before.height;
    const target = {closest: selector => selector === '.page' && !scenario.pointer ? left : null};
    // Split across frames to exercise a continuous gesture and the width threshold.
    for (let i=0;i<2;i++) {
      api.wheel({ctrlKey:true,deltaMode:0,deltaY:-Math.log(scenario.target/scenario.initial)/2/0.007,clientX,clientY,target,preventDefault(){}});
      api.flushPageFrames();
    }
    const match = /^translate\((.+)px, (.+)px\) scale\((.+)\)$/.exec(pages.style.transform);
    const shift = Number(match[1]), shiftY = Number(match[2]), scale = Number(match[3]);
    const previewLeft = clientX+(before.left-clientX)*scale+shift;
    const previewTop = clientY+(before.top-clientY)*scale+shiftY;
    assert.ok(previewTop<=72+1e-8, 'shrinking must not create a blank area above the first PDF page');
    if (600*scenario.target<=972) near(previewLeft+600*scenario.target/2,500);
    else if (scenario.initial===1) near(previewLeft,clientX+(14-clientX)*(600*scenario.target/972));
    api.finishZoomGesture();
    const after = left.getBoundingClientRect();
    near(after.left,previewLeft);
    near(after.top,previewTop);
    near(after.left+after.width*x,clientX+shift);
    near(after.top+after.height*y,clientY+shiftY);
    assert.ok(api.scrollY()>=-1e-8, 'the final anchor must not require scrolling above the document');
    if (600*scenario.target<=972) near(api.window.scrollX,0);
    assert.equal(pages.style.transform,'');
  });
});

test('saved 70% startup centers the pair seam and both single-page views using explicit CSS pixel widths', async () => {
  const api = await viewer('gemini', {}, null, 0.7);
  fitFixture(api);
  api.document.documentElement.clientWidth = 2048;
  api.element('#pages').clientWidth = 2048;
  api.state.rows = [];
  api.state.pdf = {numPages:1,getPage:async()=>({getViewport:({scale})=>({width:600*scale,height:800*scale})})};
  await api.buildRows();
  const row = api.state.rows[0];
  const assertCentered = (view) => {
    const zoom = api.rendering.viewZoom();
    assert.match(row.element.style.width,/^[\d.]+px$/);
    const rowWidth = parseFloat(row.element.style.width)*zoom;
    const pageWidth = parseFloat(row.left.style.width)*zoom;
    const contentWidth = view==='both' ? pageWidth*2+12*zoom : pageWidth;
    near(rowWidth,2048-28);
    const contentLeft = 14+(rowWidth-contentWidth)/2;
    const center = view==='both' ? contentLeft+pageWidth+6*zoom : contentLeft+pageWidth/2;
    near(center,1024);
    assert.ok(contentLeft>14);
  };
  assertCentered('both');
  for (const view of ['orig','ja','both']) {
    api.viewSelect.value = view;
    api.viewSelect.onchange();
    assertCentered(view);
  }
  api.document.documentElement.clientWidth = 1800;
  api.element('#pages').clientWidth = 1800;
  api.resize();
  near(parseFloat(row.element.style.width)*api.rendering.viewZoom(),1800-28);
});


test('vertical zoom limit uses the document start rather than the currently pointed page', async () => {
  const api = await viewer();
  fitFixture(api);
  api.viewSelect.value = 'orig';
  api.document.body.dataset.view = 'orig';
  api.state.fit = 1;
  const first = element(), second = element();
  first.getBoundingClientRect = () => ({left:350,top:-500,bottom:200,width:500,height:700});
  second.getBoundingClientRect = () => ({left:350,top:300,bottom:1000,width:500,height:700});
  api.state.rows = [
    {index:1,left:first,right:first,vp:{width:500,height:700}},
    {index:2,left:second,right:second,vp:{width:500,height:700}},
  ];
  api.wheel({ctrlKey:true,deltaMode:0,deltaY:-Math.log(0.9)/0.007,clientX:600,clientY:400,
    target:{closest:selector=>selector==='.page'?second:null},preventDefault(){}});
  api.flushPageFrames();
  const match = /^translate\((.+)px, (.+)px\) scale\((.+)\)$/.exec(api.element('#pages').style.transform);
  near(Number(match[2]),0); // Page two must keep following the pointer while the document start is above the viewport.
  near(Number(match[3]),0.9);
  api.finishZoomGesture();
});

test('opening a PDF automatically translates to Japanese locally exactly once without Gemini calls',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>assert.fail('automatic translation must stay local'));
  const options=[];
  const api=await viewer('gemini',{create:async (opts)=>{options.push(opts);return {translate:async text=>'自動訳 '+text};}});
  api.element('#dst').value='ko'; // A remembered manual target must not change the automatic Japanese default.
  await api.autoTranslateOnOpen();await idle(api);
  assert.equal(api.state.engine,'chrome');
  assert.equal(options[0].sourceLanguage,'en');assert.equal(options[0].targetLanguage,'ja');
  assert.equal(api.state.rows[0].blocks[0].ja,'自動訳 Paragraph on page 1');
  await api.autoTranslateOnOpen();assert.equal(options.length,1);
});
test('automatic translation respects opt-out, existing Japanese source, and an explicit engine choice',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>assert.fail('no implicit Gemini calls'));
  for(const mode of ['off','Japanese source','manual choice']){
    const api=await viewer();
    if(mode==='off')api.state.settings.autoTranslate=false;
    if(mode==='Japanese source')api.element('#src').value='ja';
    if(mode==='manual choice'){
      api.state.settings.geminiKey='';await api.startButton.onclick(); // Even an unsuccessful explicit choice takes precedence.
    }
    await api.autoTranslateOnOpen();await idle(api);
    assert.equal(api.state.engine,null);assert.equal(api.state.enabled,false);
  }
});
test('unavailable local AI leaves the PDF readable without an automatic Gemini fallback',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>assert.fail('no paid fallback'));
  const api=await viewer('gemini',{availability:async()=> 'unavailable'});
  await api.autoTranslateOnOpen();
  assert.equal(api.state.engine,null);assert.equal(api.state.enabled,false);
  assert.match(api.status(),/未対応/);
});

test('local to Gemini keeps current overlays and replaces only completed incoming blocks',async(t)=>{
  const f=streamFixture();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return f.response;});
  const api=await viewer();
  api.state.rows[0].blocks.push({text:'Second paragraph',translate:true,colors:{}});
  await api.localButton.onclick();await idle(api);
  const old=api.state.rows.flatMap(r=>r.blocks.map(b=>b.ja));
  const overlays=api.placedBlocks.map(entry=>entry.el);
  await api.startButton.onclick();await until(()=>calls===1);
  assert.deepEqual(api.state.rows.flatMap(r=>r.blocks.map(b=>b.ja)),old);
  assert.equal(api.placedBlocks.length,4);
  f.start();f.text('{"translations":[{"id":1,"text":"Geminiの新しい訳"},');
  await until(()=>api.state.rows[0].blocks[0].ja==='Geminiの新しい訳');
  assert.equal(overlays[0].textContent,'Geminiの新しい訳');
  assert.equal(api.state.rows[0].blocks[1].ja,old[1]);
  assert.equal(api.state.rows[1].blocks[0].ja,old[2]);
  api.element('#download').onclick();assert.equal(api.element('#downloadTranslated').disabled,true);
  f.text('{"id":2,"text":"新しい訳2"},{"id":3,"text":"新しい訳3"},{"id":4,"text":"新しい訳4"}]}');f.complete();
  await idle(api);await api.translateAll();
  assert.deepEqual(api.state.rows.flatMap(r=>r.blocks.map(b=>b.ja)),['Geminiの新しい訳','新しい訳2','新しい訳3','新しい訳4']);
  assert.equal(api.placedBlocks.length,4);
  assert.ok(overlays.every(el=>!el.removed));
});

test('Gemini to local keeps the previous translation until each local result arrives',async(t)=>{
  let first,second;
  const firstGate=new Promise(resolve=>{first=resolve;}),secondGate=new Promise(resolve=>{second=resolve;});
  t.mock.method(globalThis,'fetch',async(_url,init)=>success(JSON.parse(JSON.parse(init.body).input)));
  const api=await viewer('gemini',{create:async()=>({translate:async text=>{
    if(text.endsWith('1'))await firstGate;
    if(text.endsWith('2'))await secondGate;
    return '切替後のローカル訳 '+text;
  }})});
  await api.startButton.onclick();await idle(api);await api.translateAll();
  const old=api.state.rows.map(r=>r.blocks[0].ja),overlays=api.placedBlocks.map(entry=>entry.el);
  await api.localButton.onclick();
  assert.deepEqual(api.state.rows.map(r=>r.blocks[0].ja),old);
  first();await until(()=>api.state.rows[0].blocks[0].ja.startsWith('切替後'));
  assert.equal(api.state.rows[1].blocks[0].ja,old[1]);
  second();await idle(api);
  assert.ok(api.state.rows.every(r=>r.blocks[0].ja.startsWith('切替後')));
  assert.equal(api.placedBlocks.length,3);assert.ok(overlays.every(el=>!el.removed));
});

test('invalid Gemini replacement restores the previous local text without exposing English or enabling export',async(t)=>{
  const f=streamFixture();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return f.response;});
  const api=await viewer();await api.localButton.onclick();await idle(api);
  const old=api.state.rows.map(r=>r.blocks[0].ja),overlays=api.placedBlocks.map(entry=>entry.el);
  await api.startButton.onclick();await until(()=>calls===1);
  f.start();f.text('{"translations":[{"id":1,"text":"暫定のGemini訳"},');
  await until(()=>api.state.rows[0].blocks[0].ja==='暫定のGemini訳');
  f.text('{"id":1,"text":"重複した訳"}]}');f.complete();await idle(api);
  assert.deepEqual(api.state.rows.map(r=>r.blocks[0].ja),old);
  assert.deepEqual(overlays.map(el=>el.textContent),old);
  assert.ok(overlays.every(el=>!el.removed));
  api.element('#download').onclick();assert.equal(api.element('#downloadTranslated').disabled,true);
});

test('changing the language pair clears previous text rather than showing a translation in the wrong language',async(t)=>{
  const f=streamFixture();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return f.response;});
  const api=await viewer();await api.localButton.onclick();await idle(api);
  api.element('#dst').value='ko';
  await api.startButton.onclick();await until(()=>calls===1);
  assert.ok(api.state.rows.every(r=>r.blocks[0].ja===null));
  f.start();f.text('{"translations":[{"id":1,"text":"첫째"},{"id":2,"text":"둘째"},{"id":3,"text":"셋째"}]}');f.complete();
  await idle(api);
});
