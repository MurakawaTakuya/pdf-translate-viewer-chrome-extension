import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createGeminiTranslator } from '../gemini.js';
import { createDocumentTranslator } from '../document-translator.js';

const viewerSource = await readFile(new URL('../viewer.js', import.meta.url), 'utf8');
const element = () => ({
  value: '', style: { setProperty() {} }, classList: { add() {}, remove() {} },
  append() {}, appendChild() {}, replaceChildren() {}, remove() {}, querySelectorAll: () => [],
});
async function viewer(engine = 'gemini') {
  const elements = new Map();
  const document = {
    body: { dataset: {} }, documentElement: { scrollHeight: 1000, style: { setProperty() {} } },
    querySelector: (name) => { if (!elements.has(name)) elements.set(name, element()); return elements.get(name); },
    createElement: element,
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
    },
  };
  if (engine === 'chrome') context.self.Translator = context.Translator;
  // Run the actual viewer orchestration. Only PDF/canvas/DOM rendering is replaced.
  const source = viewerSource.replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../viewer.js', import.meta.url).href)).replace(/\nload\(\);\s*$/, `
    renderPage = async () => {};
    getPageBlocks = async (r) => r.blocks;
    releasePage = () => {};
    placeBlock = () => elementStub();
    fillBlock = (_el, b, text) => { b.ja = text; };
    return { state, start, enqueue, translateAll, status: () => $('#status').textContent };
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
    type: 'text', text: JSON.stringify({ translations: input.translate_ids.map((id) => ({ id, text: '訳文 ' + id })) }),
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
