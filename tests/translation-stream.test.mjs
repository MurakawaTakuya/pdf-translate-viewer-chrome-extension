import test from 'node:test';
import assert from 'node:assert/strict';
import { readTranslationStream } from '../translation-stream.js';
import { createGeminiTranslator } from '../gemini.js';
import { createDocumentTranslator } from '../document-translator.js';
import { streamFixture, until } from './helpers/stream.mjs';

const options = { apiKey: 'mock-key', sourceLanguage: 'en', targetLanguage: 'ja' };

test('SSE handles byte-split UTF-8, CRLF, multiline events and only complete translation objects', async () => {
  const f = streamFixture(), shown = [];
  const pending = readTranslationStream(f.response, { onItem: (item) => shown.push(item) });
  f.write(': heartbeat\r\n\r\n', 1);
  f.send({ event_type: 'step.start', index: 0, step: { type: 'thought' } });
  f.send({ event_type: 'step.delta', index: 0, delta: { type: 'text', text: '{"translations":[{"id":99,"text":"ignore thought"}]}' } });
  f.start();
  const item = { id: 2, text: '日本語 😀 "引用" と $x_{\\omega}$,\n次の行 } ]' };
  const json = JSON.stringify(item);
  const partial = '{"translations":[' + json.slice(0, -1);
  const event = { event_type: 'step.delta', index: 1, delta: { type: 'text', text: partial } };
  f.write('event: step.delta\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n', 1);
  await new Promise(setImmediate);
  assert.equal(shown.length, 0);
  f.text('},');
  await until(() => shown.length === 1);
  assert.deepEqual(shown, [item]);
  const last = JSON.stringify({ event_type: 'step.delta', index: 1, delta: { type: 'text', text: '{"id":1,"text":"最後"}]}' } });
  f.write('event: step.delta\ndata: ' + last.slice(0, last.indexOf('"delta"')) + '\ndata: ' + last.slice(last.indexOf('"delta"')) + '\n\n');
  f.complete();
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(result.text).translations, [item, { id: 1, text: '最後' }]);
  assert.deepEqual(shown.map((entry) => entry.id), [2, 1]);
  assert.equal(f.cancelled, true);
});

test('stream errors, missing completion and transport errors are not success and do not expose response contents', async (t) => {
  for (const kind of ['missing completion', 'server error', 'invalid event', 'transport']) {
    await t.test(kind, async () => {
      const f = streamFixture();
      const pending = readTranslationStream(f.response);
      const rejected = assert.rejects(pending, (error) => { assert.doesNotMatch(error.message, /secret-value/); return true; });
      f.start();
      f.text('{"translations":[{"id":1,"text":"訳"}]}');
      if (kind === 'missing completion') f.close();
      if (kind === 'server error') f.send({ event_type: 'error', error: { message: 'secret-value' } });
      if (kind === 'invalid event') f.write('data: secret-value\n\n');
      if (kind === 'transport') f.fail(new Error('Gemini transport secret-value'));
      await rejected;
    });
  }
});

test('an aborted stream stops callbacks and cancels the reader even while waiting for the next event', async () => {
  const f = streamFixture(), controller = new AbortController();
  const shown = [];
  const pending = readTranslationStream(f.response, { signal: controller.signal, onItem: (item) => shown.push(item) });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  f.start();
  f.text('{"translations":[{"id":1,"text":"訳"},');
  await until(() => shown.length === 1);
  controller.abort();
  await rejected;
  assert.equal(f.cancelled, true);
  assert.equal(shown.length, 1);
});

test('document previews arrive before completion, full validation still gates pages and all consumers share one request', async (t) => {
  const f = streamFixture(), requests = [], snapshots = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requests.push(JSON.parse(init.body)); return f.response; });
  const rows = [{ index: 1 }, { index: 2 }];
  const blocks = rows.map((r) => [{ text: `Source ${r.index}`, translate: true }]);
  let tr;
  tr = createDocumentTranslator({ rows, translator: createGeminiTranslator(options), getBlocks: async (r) => blocks[r.index - 1],
    onPreview: (r) => snapshots.push([r.index, tr.previewPage(r).map((entry) => entry.text)]),
  });
  const shown = [], pending = Promise.all(rows.map((r) => tr.translatePage(r, (_i, text) => shown.push(text))));
  f.start();
  f.text('{"translations":[{"id":1,"text":"最初の訳"},');
  await until(() => snapshots.length === 1);
  assert.deepEqual(snapshots, [[1, ['最初の訳']]]);
  assert.equal(tr.completed, false);
  assert.equal(shown.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, true);
  assert.equal(JSON.parse(requests[0].input).pages.length, 2);
  f.text('{"id":2,"text":"次の訳"}]}');
  await until(() => snapshots.length === 2);
  assert.equal(tr.completed, false); // The final API completion event is also required.
  f.complete();
  await pending;
  assert.equal(tr.completed, true);
  assert.deepEqual(shown, ['最初の訳', '次の訳']);
  await tr.translatePage(rows[1], () => {});
  assert.equal(requests.length, 1);
});

test('invalid or interrupted streamed output clears previews without splitting or automatic resending', async (t) => {
  for (const kind of ['missing', 'duplicate', 'unknown', 'empty', 'string ID', 'extra field', 'truncated', 'invalid JSON', 'network']) {
    await t.test(kind, async (s) => {
      const f = streamFixture();
      let calls = 0, resets = 0, previews = 0;
      s.mock.method(globalThis, 'fetch', async () => { calls++; return f.response; });
      const row = { index: 1 };
      const tr = createDocumentTranslator({ rows: [row], translator: createGeminiTranslator(options), getBlocks: async () => ['A', 'B'].map((text) => ({ text, translate: true })), onPreview: () => { previews++; }, onResetPreview: () => { resets++; } });
      const pending = tr.ready();
      const rejected = assert.rejects(pending);
      f.start();
      f.text('{"translations":[{"id":1,"text":"最初の訳"}');
      await until(() => previews === 1);
      if (kind === 'missing') { f.text(']}'); f.complete(); }
      if (kind === 'duplicate') { f.text(',{"id":1,"text":"重複"}]}'); f.complete(); }
      if (kind === 'unknown') { f.text(',{"id":9,"text":"対象外"}]}'); f.complete(); }
      if (kind === 'empty') { f.text(',{"id":2,"text":" "}]}'); f.complete(); }
      if (kind === 'string ID') { f.text(',{"id":"2","text":"訳"}]}'); f.complete(); }
      if (kind === 'extra field') { f.text(',{"id":2,"text":"訳","extra":true}]}'); f.complete(); }
      if (kind === 'truncated') f.close();
      if (kind === 'invalid JSON') { f.text(',]}'); f.complete(); }
      if (kind === 'network') f.fail(new Error('network down'));
      await rejected;
      assert.equal(tr.completed, false);
      assert.deepEqual(tr.previewPage(row), []);
      assert.equal(resets, 1);
      await assert.rejects(tr.ready());
      assert.equal(calls, 1);
    });
  }
});

test('manual repair of missing streamed translations sends full context once and targets only the missing block', async (t) => {
  const first = streamFixture(), repair = streamFixture(), requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(JSON.parse(init.body).input));
    return requests.length === 1 ? first.response : repair.response;
  });
  const row = { index: 1 }, blocks = ['A', 'B', 'C'].map((text) => ({ text, translate: true }));
  const tr = createDocumentTranslator({ rows: [row], translator: createGeminiTranslator(options), getBlocks: async () => blocks });
  const rejected = assert.rejects(tr.ready());
  first.start();
  first.text('{"translations":[{"id":1,"text":"最初の訳A"},{"id":3,"text":"最初の訳C"}]}');
  first.complete();
  await rejected;
  assert.equal(tr.missingCount, 1);
  assert.equal(tr.completed, false);
  const fixing = tr.repairMissing();
  assert.equal(tr.repairMissing(), fixing);
  await until(() => requests.length === 2);
  assert.deepEqual(requests[0].pages[0].blocks.map((b) => b.text), requests[1].pages[0].blocks.map((b) => b.text));
  assert.deepEqual(requests[1].pages[0].blocks.filter((b) => b.translate_id !== undefined), [{ translate_id: 1, text: 'B' }]);
  repair.start();
  repair.text('{"translations":[{"id":1,"text":"補完訳B"}]}');
  await until(() => tr.previewPage(row).length === 1);
  assert.equal(tr.previewPage(row)[0].block, blocks[1]);
  assert.equal(tr.completed, false);
  repair.complete();
  await fixing;
  const shown = [];
  await tr.translatePage(row, (_i, text) => shown.push(text));
  assert.deepEqual(shown, ['最初の訳A', '補完訳B', '最初の訳C']);
  assert.equal(tr.completed, true);
  assert.equal(tr.missingCount, 0);
  assert.equal(requests.length, 2);
});
