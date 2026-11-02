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
  for (const source of [
    {text:'Learning From Images With A Predictive Architecture',kind:'heading'},
    {text:'Learning from images with a predictive architecture',kind:'title'},
    {text:'ABSTRACT',kind:'heading'},
    {text:'1. Introduction',kind:'heading'},
  ]) assert.equal(blockIssue(source,source.text,'English','Japanese'),'unchanged');
  for (const text of ['I-JEPA', 'Mahmoud Assran', 'University of Oxford', '$x$']) {
    assert.equal(blockIssue({text,kind:'paragraph'},text,'English','Japanese'),null);
  }
});

test('unchanged explanatory captions are withheld rather than accepted as translated', () => {
  const source={text:'Figure 7. For each image, the first column contains the original image.',kind:'caption'};
  assert.equal(blockIssue(source,source.text,'English','Japanese'),'unchanged');
  assert.equal(blockIssue(source,'図7。各画像の最初の列は元の画像である。','English','Japanese'),null);
});

test('citation ranges cannot disappear and expanded equivalent ranges are accepted', async (t) => {
  for (const text of ['Prior work [4–7].','Prior work [1, 3-5].']) {
    assert.equal(blockIssue({text},'先行研究である。','English','Japanese'),'citation');
  }
  assert.equal(blockIssue({text:'Prior work [1, 3-5].'},'先行研究 [1,3,4,5]','English','Japanese'),null);
  assert.equal(blockIssue({text:'Prior work [4—7].'},'先行研究 [4,5,6,7]','English','Japanese'),null);
  const source=[{page:1,blocks:[{id:'a',text:'Prior work [4–7].',kind:'paragraph'}]}];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    const request=JSON.parse(init.body);
    return Response.json(body(JSON.stringify(output(request,['先行研究である。']))));
  });
  await assert.rejects(createKeyedGeminiTranslator(options).translateDocument(source,['a']),MissingTranslationsError);
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

test('citation groups cannot cross complete sentences, reference-only blocks or page boundaries', async () => {
  const a={id:'a',text:'We train for 10',kind:'paragraph'},b={id:'b',text:'iterations using settings [13].',kind:'paragraph'};
  for(const input of [
    [{page:1,blocks:[{...a,text:a.text+'.'},b]}],
    [{page:1,blocks:[a,{id:'reference',text:'Intervening figure label'},b]}],
    [{page:1,blocks:[a]},{page:2,blocks:[b]}],
  ]){
    const task=await buildKeyedTask(input,['a','b'],'English','Japanese');
    assert.ok([...task.groups.values()].every(group=>group.length===1));
  }
});

test('manual redo updates a shared sentence as one validated group without duplicating citations', async (t) => {
  const blocks=[{text:'We train for 300,000',kind:'paragraph',translate:true},
    {text:'iterations using settings [13]. Next we visualize representations.',kind:'paragraph',translate:true}];
  const row={index:1},requests=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    const request=JSON.parse(init.body);requests.push(request);
    const values=requests.length===1?['設定 [13] を使い300,000回学習する。','続いて表現を可視化する。']
      :['300,000回学習する。','設定 [13] を使用する。続いて表現を可視化する。'];
    return Response.json(body(JSON.stringify(output(request,values))));
  });
  const tr=createDocumentTranslator({rows:[row],translator:createKeyedGeminiTranslator(options),getBlocks:async()=>blocks});
  await tr.ready();
  const changed=await tr.retranslateBlocks(blocks[1]);
  assert.equal(changed.size,2);
  assert.equal(JSON.parse(requests[1].input).translate_count,2);
  const shown=[];await tr.translatePage(row,(_i,text)=>shown.push(text));
  assert.deepEqual(shown,['300,000回学習する。','設定 [13] を使用する。続いて表現を可視化する。']);
  assert.equal((shown.join('').match(/\[13\]/g)||[]).length,1);
  assert.equal(tr.completed,true);
});

test('a failed shared-sentence redo leaves both previous cached values intact', async (t) => {
  const blocks=[{text:'We train for 300,000',kind:'paragraph',translate:true},
    {text:'iterations using settings [13]. Next we visualize.',kind:'paragraph',translate:true}];
  const row={index:1};let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    const request=JSON.parse(init.body);calls++;
    return Response.json(body(JSON.stringify(output(request,calls===1?['設定 [13] を使い学習する。','可視化する。']:['新しい訳 [13]','誤った参照 [18]']))));
  });
  const tr=createDocumentTranslator({rows:[row],translator:createKeyedGeminiTranslator(options),getBlocks:async()=>blocks});
  await tr.ready();
  await assert.rejects(tr.retranslateBlock(blocks[1]),MissingTranslationsError);
  const shown=[];await tr.translatePage(row,(_i,text)=>shown.push(text));
  assert.deepEqual(shown,['設定 [13] を使い学習する。','可視化する。']);
  assert.equal(tr.completed,true);
});

test('diagnostics shrink after partial repair, survive invalid repair and clear only after success', async (t) => {
  const rows = [{ index: 1 }, { index: 2 }];
  const blocks = [
    [{ text: 'Reference only', translate: false }, { text: 'Original <img onerror="attack()"> cites [4].', kind: 'paragraph', translate: true }],
    [{ text: 'Abstract', kind: 'heading', translate: true }],
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body), keys = Object.keys(request.response_format.schema.properties);
    const values = calls === 1 ? ['保留 <svg onload="attack()">', 'Abstract'] : calls === 2 ? ['別の保留', '要旨'] : ['引用 [4]'];
    return Response.json(body(calls === 3 ? '{ broken' : JSON.stringify(Object.fromEntries(keys.map((key, i) => [key, values[i]])))));
  });
  const tr = createDocumentTranslator({ rows, getBlocks: async (row) => blocks[row.index - 1], translator: createKeyedGeminiTranslator(options) });
  const error = await tr.ready().catch((error) => error);
  assert.ok(error instanceof MissingTranslationsError);
  assert.deepEqual(tr.issues.map(({ page, block, reason }) => [page, block, reason]), [[1, 1, 'citation'], [2, 1, 'unchanged']]);
  assert.equal(tr.issues[0].source, blocks[0][1].text);
  assert.ok(!JSON.stringify(error).includes('attack'));
  const copy = error.issues; copy[0].source = 'tampered'; assert.notEqual(error.issues[0].source, 'tampered');
  await assert.rejects(tr.repairMissing(), MissingTranslationsError);
  assert.equal(tr.issues.length, 1);
  assert.equal(tr.issues[0].translated, '別の保留');
  const last = tr.issues;
  await assert.rejects(tr.repairMissing());
  assert.deepEqual(tr.issues, last);
  assert.equal(tr.completed, false);
  await tr.repairMissing();
  assert.deepEqual(tr.issues, []);
  assert.equal(tr.missingCount, 0);
  assert.equal(tr.completed, true);
  assert.equal(calls, 4);
});
