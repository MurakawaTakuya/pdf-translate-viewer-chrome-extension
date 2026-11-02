import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiTranslator, MissingTranslationsError } from '../gemini.js';
import { inspect } from 'node:util';
import { createDocumentTranslator } from '../document-translator.js';

const options = { apiKey: 'mock-key', sourceLanguage: 'en', targetLanguage: 'ja', inputFormat: 'separate-targets' };
const response = (translations, extra = {}) => Response.json({
  status: 'completed',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ translations }) }] }],
  ...extra,
});
const targets = (input) => [...input.targets];
const contextText = (input) => input.pages;
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
    // Response order is irrelevant: the numeric IDs must restore the original sparse IDs.
    return response(targets(input).reverse().map((b) => ({ id: b.id, text: `訳文 ${b.id} (${requests.length})` })));
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
  assert.match(requests[0].input.pages[2].text, /^Figure label 2\n\nParagraph 2:0/);
  assert.deepEqual(contextText(requests[0].input), rows.map((r, i) => ({ page: r.index, text: blocks[i].map((b) => b.text).join('\n\n') })));
  assert.ok(blocks.flat().every((b) => b.id === undefined));
  assert.equal(requests[0].input.translate_count, 36);
  assert.ok(targets(requests[0].input).every((b) => !b.text.startsWith('Figure label')));
  assert.deepEqual(targets(requests[0].input).map((b) => b.id), Array.from({ length: 36 }, (_, i) => i + 1));
  assert.equal(shown[2][0], '訳文 25 (1)');
  assert.equal(shown[0][11], '訳文 12 (1)');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.generation_config.max_output_tokens, 65536);
  const schema = requests[0].body.response_format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['translations']);
  assert.equal(schema.properties.translations.type, 'array');
  assert.equal(schema.properties.translations.items.properties.id.type, 'integer');
  assert.equal(schema.properties.translations.items.properties.text.type, 'string');
  assert.match(requests[0].body.system_instruction, /numbered consecutively from 1/);
  await Promise.all(rows.map((r) => tr.translatePage(r, () => {})));
  assert.equal(requests.length, 1);

  const replacement = await tr.retranslateBlock(blocks[2][1]);
  assert.equal(replacement, '訳文 1 (2)');
  assert.equal(requests.length, 2);
  assert.deepEqual(contextText(requests[1].input), contextText(requests[0].input));
  assert.equal(requests[1].input.translate_count, 1);
  assert.deepEqual(targets(requests[1].input), [{ id: 1, page: 3, kind: 'paragraph', text: blocks[2][1].text }]);
  assert.deepEqual(requests[1].body.response_format.schema, schema);
  await tr.translatePage(rows[2], (i, text) => { shown[2][i] = text; });
  assert.equal(shown[2][0], replacement);
  assert.equal(requests.length, 2);
});

test('schema stays identical for 1, 282 and 2000 paragraphs without IDs or length limits', async (t) => {
  const schemas = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body), input = JSON.parse(request.input);
    schemas.push(request.response_format.schema);
    return response(targets(input).map((b) => ({ id: b.id, text: '訳文 ' + b.id })));
  });
  const translator = createGeminiTranslator(options);
  for (const count of [1, 282, 2000]) {
    const blocks = Array.from({ length: count }, (_, i) => ({ id: `p1-b${i}`, text: `Source ${i}` }));
    const result = await translator.translateDocument([{ page: 1, blocks }], blocks.map((b) => b.id));
    assert.equal(result.size, count);
    assert.equal(result.get(`p1-b${count - 1}`), `訳文 ${count}`);
  }
  assert.equal(schemas.length, 3); // One request per document, without fallback/resending.
  for (const schema of schemas) {
    assert.deepEqual(schema, schemas[0]);
    assert.doesNotMatch(JSON.stringify(schema), /prefixItems|minItems|maxItems|enum|p1-b/);
  }
});

test('malformed or incomplete output never causes splitting, resending, or partial display', async (t) => {
  const cases = {
    missing: [[{ id: 1, text: '訳' }], /必要2件／受信1件、不足1件/],
    unknown: [[{ id: 1, text: '訳' }, { id: 3, text: '訳' }], /不足1件、対象外1件/],
    zero: [[{ id: 1, text: '訳' }, { id: 0, text: '訳' }], /対象外1件/],
    duplicate: [[{ id: 1, text: '訳' }, { id: 1, text: '訳' }], /重複1件/],
    stringID: [[{ id: 1, text: '訳' }, { id: '2', text: '訳' }], /形式不正1件/],
    empty: [[{ id: 1, text: '訳' }, { id: 2, text: '  ' }], /空欄1件/],
    wrongType: [[{ id: 1, text: '訳' }, { id: 2, text: 123 }], /形式不正1件/],
    extraField: [[{ id: 1, text: '訳' }, { id: 2, text: '訳', extra: true }], /形式不正1件/],
    oldDictionary: [{ 'p1-b0': '訳', 'p1-b1': '訳' }, /形式が不正/],
    null: [null, /形式が不正/],
  };
  for (const [name, [entries, message]] of Object.entries(cases)) {
    await t.test(name, async (s) => {
      let calls = 0, displays = 0;
      s.mock.method(globalThis, 'fetch', async () => { calls++; return response(entries); });
      const rows = [{ index: 1 }];
      const tr = createDocumentTranslator({
        rows, translator: createGeminiTranslator(options),
        getBlocks: async () => [{ text: 'One paragraph', translate: true }, { text: 'Another paragraph', translate: true }],
      });
      await assert.rejects(tr.translatePage(rows[0], () => { displays++; }), (error) => {
        assert.match(error.message, message);
        assert.ok(!error.message.includes('mock-key'));
        assert.ok(!error.message.includes('One paragraph'));
        assert.ok(!error.message.includes('p1-b0'));
        return true;
      });
      await assert.rejects(tr.translatePage(rows[0], () => { displays++; }));
      await assert.rejects(tr.ready());
      assert.equal(tr.missingCount, name === 'missing' ? 1 : 0);
      assert.equal(calls, 1);
      assert.equal(displays, 0);
    });
  }
  await t.test('truncated output', async (s) => {
    let calls = 0;
    s.mock.method(globalThis, 'fetch', async () => { calls++; return response([{ id: 1, text: '訳' }], { status: 'incomplete' }); });
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

test('281 valid translations are retained and only the missing target is repaired on demand', async (t) => {
  const rows = [1, 2, 3].map((index) => ({ index }));
  const blocks = rows.map((r) => [
    { text: `Reference ${r.index}`, translate: false },
    ...Array.from({ length: 94 }, (_, i) => ({ text: `Paragraph ${r.index}:${i}`, translate: true })),
  ]);
  const requests = [], gate = deferred(), repairStarted = deferred();
  const missingText = 'Paragraph 2:29';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const input = JSON.parse(JSON.parse(init.body).input);
    requests.push(input);
    if (requests.length === 1) {
      return response(targets(input).filter((b) => b.text !== missingText).map((b) => ({ id: b.id, text: '初回訳 ' + b.text })));
    }
    assert.equal(requests.length, 2);
    repairStarted.resolve();
    await gate.promise;
    return response([{ id: 1, text: '補完した訳文' }]);
  });
  const tr = createDocumentTranslator({ rows, translator: createGeminiTranslator(options), getBlocks: async (r) => blocks[r.index - 1] });
  await assert.rejects(tr.ready(), (error) => {
    assert.ok(error instanceof MissingTranslationsError);
    assert.deepEqual(error.missingIds, ['p2-b30']);
    assert.equal(error.partialTranslations.size, 281);
    assert.ok(!inspect(error).includes('初回訳'));
    assert.ok(!JSON.stringify(error).includes('初回訳'));
    return true;
  });
  assert.equal(tr.missingCount, 1);
  await assert.rejects(tr.translatePage(rows[0], () => assert.fail('must not display incomplete document')));
  assert.equal(requests.length, 1);
  const repair = tr.repairMissing();
  assert.equal(tr.repairMissing(), repair);
  assert.equal(tr.ready(), repair);
  await repairStarted.promise;
  assert.equal(requests.length, 2);
  assert.deepEqual(contextText(requests[1]), contextText(requests[0]));
  assert.equal(requests[1].translate_count, 1);
  assert.deepEqual(targets(requests[1]), [{ id: 1, page: 2, kind: 'paragraph', text: missingText }]);
  gate.resolve();
  const result = await repair;
  assert.equal(result.size, 282);
  assert.equal(tr.missingCount, 0);
  for (const r of rows) {
    const shown = [];
    await tr.translatePage(r, (i, text) => { shown[i] = text; });
    assert.deepEqual(shown, blocks[r.index - 1].filter((b) => b.translate).map((b) => b.text === missingText ? '補完した訳文' : '初回訳 ' + b.text));
  }
  await tr.repairMissing();
  assert.equal(requests.length, 2);
});

test('partial repair and API failure retain successful results for the next manual attempt', async (t) => {
  const row = { index: 1 }, requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(JSON.parse(init.body).input));
    switch (requests.length) {
      case 1: return response([{ id: 1, text: '初回訳' }]);
      case 2: return response([{ id: 2, text: '一部補完' }]);
      case 3: return Response.json({ error: { message: 'mock failure' } }, { status: 400 });
      case 4: return response([{ id: 1, text: '最後の補完' }]);
      default: assert.fail('unexpected request');
    }
  });
  const tr = createDocumentTranslator({ rows: [row], translator: createGeminiTranslator(options), getBlocks: async () => ['A', 'B', 'C'].map((text) => ({ text, translate: true })) });
  await assert.rejects(tr.ready());
  assert.equal(tr.missingCount, 2);
  await assert.rejects(tr.repairMissing());
  assert.equal(tr.missingCount, 1);
  await assert.rejects(tr.repairMissing(), /400/);
  assert.equal(tr.missingCount, 1);
  await assert.rejects(tr.ready());
  assert.equal(requests.length, 3);
  const result = await tr.repairMissing();
  assert.deepEqual([...result].sort(), [['p1-b0', '初回訳'], ['p1-b1', '最後の補完'], ['p1-b2', '一部補完']]);
  assert.deepEqual(requests.map((r) => targets(r).map((b) => b.text)), [['A', 'B', 'C'], ['B', 'C'], ['B'], ['B']]);
});

test('cancelling a repair stops its request and does not complete the document', async (t) => {
  const controller = new AbortController(), started = deferred();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    calls++;
    if (calls === 1) return response([{ id: 1, text: '初回訳' }]);
    started.resolve();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const tr = createDocumentTranslator({ rows: [{ index: 1 }], signal: controller.signal, translator: createGeminiTranslator({ ...options, signal: controller.signal }), getBlocks: async () => ['A', 'B'].map((text) => ({ text, translate: true })) });
  await assert.rejects(tr.ready());
  const pending = tr.repairMissing();
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(tr.missingCount, 1);
  assert.equal(calls, 2);
});

test('reported 282/196 ID drift is rejected without guessing matches or resending', async (t) => {
  const ids = Array.from({ length: 282 }, (_, i) => `p1-b${i}`);
  const entries = [
    ...Array.from({ length: 34 }, (_, i) => ({ id: i + 1, text: '訳文' })),
    ...Array.from({ length: 162 }, (_, i) => ({ id: 283 + i, text: '訳文' })),
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(entries); });
  await assert.rejects(createGeminiTranslator(options).translateDocument([], ids), /必要282件／受信196件、不足248件、対象外162件/);
  assert.equal(calls, 1);
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
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response([{ id: 1, text: 'こんにちは、世界。' }]); });
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
    return response([{ id: 1, text: '訳' }]);
  });
  const result = await createGeminiTranslator(options).translateDocument([{ page: 1, blocks: [{ id: 'a', text: 'Source paragraph' }] }], ['a']);
  assert.equal(result.get('a'), '訳');
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
});
