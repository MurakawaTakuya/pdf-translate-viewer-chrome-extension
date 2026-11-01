import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedGeminiTranslator, MissingTranslationsError } from '../gemini.js';
import { createDocumentTranslator } from '../document-translator.js';
import { buildKeyedTask, keyedMembers, blockIssue, taskIssue } from '../keyed-translations.js';
import { keyedCase } from '../scripts/evaluation/keyed-format.mjs';
import { streamFixture, until } from './helpers/stream.mjs';

const options = { apiKey: 'mock-key', sourceLanguage: 'en', targetLanguage: 'ja' };
const pages = [{ page: 1, blocks: [
  { id: 'a', text: 'Untranslated reference row 99', translate: false },
  { id: 'b', text: 'First paragraph cites [4, 5, 18].', kind: 'paragraph', translate: true },
  { id: 'c', text: 'Second paragraph.', kind: 'paragraph', translate: true },
] }];
const ids = ['b', 'c'];
const body = (text, status = 'completed') => ({ status, steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
const output = (request, values) => Object.fromEntries(Object.keys(request.response_format.schema.properties).map((key, i) => [key, values[i]]));

test('production task-bound request exactly matches the evaluated candidate without another remote call', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    request = JSON.parse(init.body);
    return Response.json(body(JSON.stringify(output(request, ['最初 [4,5,18]', '次の訳']))));
  });
  const translated = await createKeyedGeminiTranslator(options).translateDocument(pages, ids);
  const candidate = await keyedCase(pages, { sourceBound: true, taskBound: true });
  assert.deepEqual(request, candidate.request);
  assert.equal(translated.get('b'), '最初 [4,5,18]');
  assert.equal(JSON.parse(request.input).pages[0].blocks[0].translate_id, undefined);
});

test('keyed stream handles every character boundary, escaped keys and embedded JSON-looking strings', () => {
  const text = '{"a\\u0062":"日本語 \\"key\\": \\"value\\" 😀","cd":"$x_{\\\\omega}$\\n続き"}';
  const seen = [], collector = keyedMembers((item) => seen.push(item));
  for (const char of text) collector.append(char);
  assert.deepEqual(collector.finish(), [{ id: 'ab', text: '日本語 "key": "value" 😀' }, { id: 'cd', text: '$x_{\\omega}$\n続き' }]);
  assert.equal(seen.length, 2);
});

test('keyed collector rejects non-string duplicates even if JSON.parse would hide the first value', () => {
  for (const value of ['123', '{}', '[]', 'null', 'true', 'false']) {
    const collector = keyedMembers(); collector.append(`{"a":${value},"a":"訳"}`);
    assert.throws(() => collector.finish());
  }
  for (const text of ['{"a":"訳",}', '{"a":"訳"} {}', '["訳"]', '{"a":"未完']) {
    const collector = keyedMembers(); collector.append(text); assert.throws(() => collector.finish());
  }
});

test('citation checks preserve repeated markers while tolerating spacing and full-width digits', () => {
  const source = { text: 'Cited [4,5] and again [4].', kind: 'paragraph' };
  assert.equal(blockIssue(source, '引用 [４, ５] と再引用 [4]', 'English', 'Japanese'), null);
  assert.equal(blockIssue(source, '引用 [4,5]', 'English', 'Japanese'), 'citation');
  assert.equal(blockIssue(source, '引用 [4,5] [4,18]', 'English', 'Japanese'), 'citation');
  assert.equal(blockIssue({text:'Methods without augmentation data2vec [8]'}, '手法 data2vec [8] MAE [36]', 'English', 'Japanese'), 'citation');
});

test('ordinary source headings cannot silently remain English, while names and formulas can', () => {
  const title = { text: 'Learning from Images with a Predictive Architecture', kind: 'heading' };
  assert.equal(blockIssue(title, title.text, 'English', 'Japanese'), 'unchanged');
  for (const text of ['I-JEPA', 'Mahmoud Assran', 'University of Oxford', '$x$']) {
    assert.equal(blockIssue({text,kind:'paragraph'},text,'English','Japanese'),null);
  }
});

test('streaming withholds a citation-mismatched block before preview, retains safe results and makes no automatic repair call', async (t) => {
  const f = streamFixture(), shown = [];
  let request, calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { calls++; request = JSON.parse(init.body); return f.response; });
  const pending = createKeyedGeminiTranslator(options).translateDocument(pages, ids, (...item) => shown.push(item));
  const rejected = assert.rejects(pending, (error) => {
    assert.ok(error instanceof MissingTranslationsError);
    assert.deepEqual(error.missingIds, ['b']);
    assert.deepEqual([...error.partialTranslations], [['c', '次の訳']]);
    assert.match(error.message, /参照番号不一致1件/);
    return true;
  });
  await until(() => !!request);
  const [a, b] = Object.keys(request.response_format.schema.properties);
  f.start(); f.text(`{"${a}":"引用が欠けた訳","${b}":"次の`);
  await new Promise(setImmediate); assert.deepEqual(shown, []);
  f.text('訳"}'); await until(() => shown.length === 1);
  assert.deepEqual(shown, [['c', '次の訳']]);
  f.complete(); await rejected;
  assert.equal(calls, 1);
});

test('missing keyed results and explicit repair share full context and keep stable block keys', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    return Response.json(body(JSON.stringify(output(request, requests.length === 1 ? ['欠落した引用', '次の訳'] : ['補完した訳 [4,5,18]']))));
  });
  const row = { index: 1 }, blocks = pages[0].blocks.map((b) => ({ ...b }));
  const tr = createDocumentTranslator({ rows: [row], translator: createKeyedGeminiTranslator(options), getBlocks: async () => blocks });
  await assert.rejects(tr.ready(), MissingTranslationsError);
  assert.equal(tr.missingCount, 1); assert.equal(tr.completed, false);
  await tr.repairMissing();
  assert.equal(requests.length, 2); assert.equal(tr.completed, true);
  const first = JSON.parse(requests[0].input), second = JSON.parse(requests[1].input);
  assert.deepEqual(first.pages[0].blocks.map((b) => b.text), second.pages[0].blocks.map((b) => b.text));
  assert.equal(second.translate_count, 1);
  assert.equal(first.pages[0].blocks[1].translate_id, second.pages[0].blocks[1].translate_id);
  const shown = [];
  await tr.translatePage(row, (_i, text) => shown.push(text));
  assert.deepEqual(shown, ['補完した訳 [4,5,18]', '次の訳']);
  assert.equal(requests.length, 2);
});

test('unknown, duplicate and malformed keyed responses fail the whole result instead of enabling partial repair', async (t) => {
  for (const kind of ['unknown', 'duplicate', 'non-string', 'empty', 'incomplete']) await t.test(kind, async (s) => {
    s.mock.method(globalThis, 'fetch', async (_url, init) => {
      const request = JSON.parse(init.body), [a, b] = Object.keys(request.response_format.schema.properties);
      let text = JSON.stringify(output(request, ['訳 [4,5,18]', '次']));
      if (kind === 'unknown') text = text.slice(0, -1) + ',"unknown":"訳"}';
      if (kind === 'duplicate') text = `{"${a}":"訳 [4,5,18]","${a}":"重複","${b}":"次"}`;
      if (kind === 'non-string') text = `{"${a}":123,"${a}":"訳 [4,5,18]","${b}":"次"}`;
      if (kind === 'empty') text = JSON.stringify(output(request, [' ', '次']));
      return Response.json(body(text, kind === 'incomplete' ? 'incomplete' : 'completed'));
    });
    await assert.rejects(createKeyedGeminiTranslator(options).translateDocument(pages, ids), (error) => !(error instanceof MissingTranslationsError));
  });
});

test('abort before keyed preparation performs no remote call', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('must not send after abort'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createKeyedGeminiTranslator({...options,signal:controller.signal}).translateDocument(pages,ids),{name:'AbortError'});
});

test('the keyed schema uses the selected language pair and rejects duplicate task IDs before sending', async () => {
  const task = await buildKeyedTask(pages, ids, 'French', 'English');
  assert.match(Object.values(task.schema.properties)[0].description, /from French into English/);
  await assert.rejects(buildKeyedTask(pages, ['b', 'b'], 'English', 'Japanese'), /重複/);
});

test('only adjacent number/unit fragments share citation checks; table labels remain independent', async () => {
  const input=[{page:1,blocks:[
    {id:'a',text:'We train for 300,000',kind:'paragraph'},
    {id:'b',text:'iterations using default settings [13]. Next we visualize representations.',kind:'paragraph'},
    {id:'c',text:'Methods without augmentation data2vec [8]',kind:'paragraph'},
    {id:'d',text:'iBOT [79]',kind:'paragraph'},
  ]}];
  const task=await buildKeyedTask(input,['a','b','c','d'],'English','Japanese'),keys=[...task.byKey.keys()];
  const values=new Map([[keys[0],'既定の設定 [13] を使用して300,000反復学習する。']]);
  assert.equal(taskIssue(task,keys[0],values,'English','Japanese'),'pending');
  values.set(keys[1],'続いて表現を可視化する。');
  assert.equal(taskIssue(task,keys[0],values,'English','Japanese'),null);
  assert.equal(task.groups.get(keys[2]).length,1);
  assert.equal(task.groups.get(keys[3]).length,1);
});
