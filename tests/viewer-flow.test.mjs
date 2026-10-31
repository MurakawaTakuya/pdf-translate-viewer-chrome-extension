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
async function viewer(engine = 'gemini', localTranslator = {}) {
  const elements = new Map();
  const document = {
    body: { dataset: {} }, documentElement: { scrollHeight: 1000, style: { setProperty() {} } },
    querySelector: (name) => { if (!elements.has(name)) elements.set(name, element()); return elements.get(name); },
    createElement: (tagName) => {
      const el = element();
      el.tagName = tagName;
      if (tagName === 'canvas') el.getContext = () => ({ drawImage() {} });
      return el;
    },
  };
  const window = {}; window.top = window;
  const context = {
    document, window, self: {}, location: { search: '' },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ addEventListener() {} }), devicePixelRatio: 1, scrollY: 0, scrollTo() {},
    AbortController, URL, setTimeout, clearTimeout, console: { error() {} },
    pdfjsLib: { GlobalWorkerOptions: {} },
    createGeminiTranslator, createDocumentTranslator,
    loadSettings: async () => ({ engine, geminiKey: 'mock-key', geminiModel: 'gemini-3.5-flash-lite' }),
    openSettings: async () => null,
    Translator: {
      availability: async () => 'available',
      create: async () => ({ translate: async (text) => 'ローカル訳: ' + text }),
      ...localTranslator,
    },
  };
  if (engine === 'chrome') context.self.Translator = context.Translator;
  // Run the actual viewer orchestration. Only PDF/canvas/DOM rendering is replaced.
  const source = viewerSource.replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../viewer.js', import.meta.url).href)).replace(/\nload\(\);\s*$/, `
    const rendering = { pixelScale, makeCanvas, renderPage, releasePage };
    renderPage = async () => {};
    getPageBlocks = async (r) => r.blocks;
    releasePage = () => {};
    placeBlock = () => elementStub();
    fillBlock = (_el, b, text) => { b.ja = text; };
    return { state, start, enqueue, translateAll, status: () => $('#status').textContent, startButton: $('#start'), beginTranslation, rendering, window, viewSelect: viewSel };
  `);
  context.elementStub = element;
  const api = await vm.runInNewContext('(async () => {' + source + '})()', context);
  api.state.pdf = {};
  api.state.rows = [1, 2, 3].map((index) => ({
    index, visible: index === 1, srcLayer: element(), dstLayer: element(),
    blocks: [{ text: `Paragraph on page ${index}`, translate: true, colors: {} }],
  }));
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
    type: 'text', text: JSON.stringify({ translations: Object.fromEntries(input.translate_ids.map((id) => [id, '訳文 ' + id])) }),
  }] }] });
}

test('viewer translates all pages on start and renders unseen pages for export without another request', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const input = JSON.parse(JSON.parse(init.body).input); requests.push(input); return success(input);
  });
  const api = await viewer();
  await api.start();
  await idle(api);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pages.length, 3);
  assert.equal(requests[0].translate_ids.length, 3);
  assert.equal(api.state.rows[0].blocks[0].ja, '訳文 p1-b0');
  assert.ok(!api.state.rows[2].translated);
  await api.translateAll();
  assert.equal(requests.length, 1);
  assert.ok(api.state.rows.every((r) => r.translated));
  assert.equal(api.state.rows[2].blocks[0].ja, '訳文 p3-b0');
});

test('viewer preserves Chrome local per-page translation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not use API'));
  const api = await viewer('chrome');
  await api.start();
  await idle(api);
  assert.equal(api.state.rows[0].blocks[0].ja, 'ローカル訳: Paragraph on page 1');
  assert.ok(!api.state.rows[2].translated);
  await api.translateAll();
  assert.ok(api.state.rows.every((r) => r.translated));
});

test('viewer rejects incomplete output and export without additional requests', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; return Response.json({ status: 'incomplete', steps: [] });
  });
  const api = await viewer();
  await api.start();
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
  await api.start();
  await firstStarted;
  await api.start();
  await idle(api);
  assert.equal(calls, 2);
  assert.equal(api.state.rows[0].blocks[0].ja, '訳文 p1-b0');
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
  await api.start();
  await requestStarted;
  assert.equal(api.startButton.disabled, true);
  assert.equal(api.startButton.textContent, '翻訳中…');
  assert.ok(api.startButton.classList.contains('loading'));
  assert.equal(api.startButton.getAttribute('aria-busy'), 'true');
  release();
  await idle(api);
  assert.equal(api.startButton.disabled, false);
  assert.equal(api.startButton.textContent, '翻訳開始');
  assert.ok(!api.startButton.classList.contains('loading'));
});

test('failed local translator preparation releases the start button', async () => {
  const api = await viewer('chrome', { availability: async () => 'unavailable' });
  await api.start();
  assert.match(api.status(), /未対応/);
  assert.equal(api.startButton.disabled, false);
  assert.equal(api.startButton.getAttribute('aria-busy'), 'false');
});

test('completion of an older task cannot clear the current loading indicator', async () => {
  const api = await viewer();
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
