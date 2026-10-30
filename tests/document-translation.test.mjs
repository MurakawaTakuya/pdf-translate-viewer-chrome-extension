import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiTranslator } from '../gemini.js';
import { createDocumentTranslator } from '../document-translator.js';

const options = { apiKey: 'mock-key', sourceLanguage: 'en', targetLanguage: 'ja' };
const response = (translations, extra = {}) => Response.json({
  status: 'completed',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ translations }) }] }],
  ...extra,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('all pages use one request; scrolling/export reuse it; manual redo retains full context', async (t) => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ index: i + 1 }));
  const blocks = rows.map((_, p) => [
    { text: `Figure label ${p}`, translate: false },
    ...Array.from({ length: 12 }, (_, i) => ({ text: `Paragraph ${p}:${i} ` + 'x'.repeat(3501), translate: true })),
  ]);
  const requests = [], extractions = [];
  const gate = deferred();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body), input = JSON.parse(body.input);
    requests.push({ body, input });
    await gate.promise;
    // The API may reorder objects: IDs must preserve the page/paragraph association.
    return response([...input.translate_ids].reverse().map((id) => ({ id, text: `訳文 ${id} (${requests.length})` })));
  });
  const tr = createDocumentTranslator({
    rows, translator: createGeminiTranslator(options),
    getBlocks: async (r) => { extractions.push(r.index); return blocks[r.index - 1]; },
  });
  const shown = [[], [], []];
  const pending = [tr.ready(), ...rows.map((r, p) => tr.translatePage(r, (i, text) => { shown[p][i] = text; }))];
  gate.resolve();
  await Promise.all(pending);
  assert.equal(requests.length, 1);
  assert.deepEqual(extractions, [1, 2, 3]);
  assert.equal(requests[0].input.pages.length, 3);
  assert.equal(requests[0].input.pages[2].blocks.length, 13);
  assert.equal(requests[0].input.pages[2].blocks[0].text, 'Figure label 2');
  assert.equal(requests[0].input.translate_ids.length, 36);
  assert.ok(!requests[0].input.translate_ids.includes('p3-b0'));
  assert.equal(shown[2][0], '訳文 p3-b1 (1)');
  assert.equal(shown[0][11], '訳文 p1-b12 (1)');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.generation_config.max_output_tokens, 65536);
  await Promise.all(rows.map((r) => tr.translatePage(r, () => {})));
  assert.equal(requests.length, 1);

  const replacement = await tr.retranslateBlock(blocks[2][1]);
  assert.equal(replacement, '訳文 p3-b1 (2)');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].input.pages, requests[0].input.pages);
  assert.deepEqual(requests[1].input.translate_ids, ['p3-b1']);
  await tr.translatePage(rows[2], (i, text) => { shown[2][i] = text; });
  assert.equal(shown[2][0], replacement);
  assert.equal(requests.length, 2);
});

test('malformed or incomplete output never causes splitting, resending, or partial display', async (t) => {
  const cases = {
    missing: [{ id: 'p1-b0', text: '訳' }],
    duplicate: [{ id: 'p1-b0', text: '訳' }, { id: 'p1-b0', text: '訳' }],
    unknown: [{ id: 'p1-b0', text: '訳' }, { id: 'other', text: '訳' }],
    empty: [{ id: 'p1-b0', text: '訳' }, { id: 'p1-b1', text: '  ' }],
    wrongType: [{ id: 'p1-b0', text: '訳' }, { id: 'p1-b1', text: 123 }],
  };
  for (const [name, entries] of Object.entries(cases)) {
    await t.test(name, async (s) => {
      let calls = 0, displays = 0;
      s.mock.method(globalThis, 'fetch', async () => { calls++; return response(entries); });
      const rows = [{ index: 1 }];
      const tr = createDocumentTranslator({
        rows, translator: createGeminiTranslator(options),
        getBlocks: async () => [{ text: 'One paragraph', translate: true }, { text: 'Another paragraph', translate: true }],
      });
      await assert.rejects(tr.translatePage(rows[0], () => { displays++; }));
      await assert.rejects(tr.translatePage(rows[0], () => { displays++; }));
      await assert.rejects(tr.ready());
      assert.equal(calls, 1);
      assert.equal(displays, 0);
    });
  }
  await t.test('truncated output', async (s) => {
    let calls = 0;
    s.mock.method(globalThis, 'fetch', async () => { calls++; return response([{ id: 'a', text: '訳' }], { status: 'incomplete' }); });
    await assert.rejects(createGeminiTranslator(options).translateDocument([], ['a']), /途中で切れ/);
    assert.equal(calls, 1);
  });
  await t.test('invalid JSON', async (s) => {
    let calls = 0;
    s.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{' }] }] });
    });
    await assert.rejects(createGeminiTranslator(options).translateDocument([], ['a']), /応答を読み取れ/);
    assert.equal(calls, 1);
  });
});

test('API failure is shared between page consumers and does not silently fall back', async (t) => {
  for (const status of [400, 403, 404]) {
    await t.test(String(status), async (s) => {
      let calls = 0;
      s.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { message: 'mock failure' } }, { status }); });
      const rows = [{ index: 1 }, { index: 2 }];
      const tr = createDocumentTranslator({
        rows, translator: createGeminiTranslator(options),
        getBlocks: async () => [{ text: 'A paragraph', translate: true }],
      });
      const results = await Promise.allSettled(rows.map((r) => tr.translatePage(r, () => assert.fail('must not display'))));
      assert.ok(results.every((r) => r.status === 'rejected'));
      assert.equal(calls, 1);
    });
  }
});

test('an empty/image-only document needs no API request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not call API'));
  const row = { index: 1 };
  const tr = createDocumentTranslator({ rows: [row], translator: createGeminiTranslator(options), getBlocks: async () => [] });
  await tr.translatePage(row, () => assert.fail('must not display'));
});

test('settings connection test still makes a single request', async (t) => {
  let calls = 0, result;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response([{ id: '0', text: 'こんにちは、世界。' }]); });
  await createGeminiTranslator(options).translateBatch(['Hello, world.'], (_, text) => { result = text; });
  assert.equal(calls, 1);
  assert.equal(result, 'こんにちは、世界。');
});

test('cancelling during document extraction prevents sending a stale request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not call API'));
  const controller = new AbortController(), gate = deferred();
  const tr = createDocumentTranslator({
    rows: [{ index: 1 }], signal: controller.signal,
    translator: createGeminiTranslator({ ...options, signal: controller.signal }),
    getBlocks: async () => { await gate.promise; return [{ text: 'A paragraph', translate: true }]; },
  });
  const pending = tr.ready();
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('cancelling an in-flight request reaches fetch and stops page callbacks', async (t) => {
  const controller = new AbortController(), started = deferred();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    assert.equal(signal, controller.signal);
    started.resolve();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const row = { index: 1 };
  const tr = createDocumentTranslator({
    rows: [row], signal: controller.signal,
    translator: createGeminiTranslator({ ...options, signal: controller.signal }),
    getBlocks: async () => [{ text: 'A paragraph', translate: true }],
  });
  const pending = tr.translatePage(row, () => assert.fail('must not display'));
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('rate-limit wait is cancellable without another API call', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: {} }, { status: 429 }); });
  const tr = createGeminiTranslator({ ...options, signal: controller.signal, onWait: () => controller.abort() });
  await assert.rejects(tr.translateDocument([], ['a']), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('temporary server failure retries the same full document', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body).input);
    if (requests.length === 1) return Response.json({ error: { details: [{ retryDelay: '0.001s' }] } }, { status: 503 });
    return response([{ id: 'a', text: '訳' }]);
  });
  const result = await createGeminiTranslator(options).translateDocument([{ page: 1, blocks: [{ id: 'a', text: 'Source paragraph' }] }], ['a']);
  assert.equal(result.get('a'), '訳');
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
});
