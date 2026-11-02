import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeTask,createNodeGeminiTranslator,nodePrompt } from '../node-translations.js';
import { strictJson,jsonMembers } from '../json-members.js';
import { MissingTranslationsError } from '../gemini.js';
import { protectedRuns } from '../protected-spans.js';
import { streamFixture,until } from './helpers/stream.mjs';

const pages=()=>[{page:1,blocks:[{id:'a',text:'Reconstruct image x from vector sx [13]. RN152 is used.',kind:'paragraph',translate:true,
  mathSpans:[{start:18,end:19,text:'x',x0:10,x1:16,top:10,bottom:21,base:18,h:10},{start:32,end:34,text:'sx',x0:20,x1:30,top:10,bottom:21,base:18,h:10}]},
  {id:'b',text:'Abstract',kind:'heading',translate:true}]}];
const options={apiKey:'mock-key',sourceLanguage:'en',targetLanguage:'ja'};
const response=(value)=>Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(value)}]}]});
const body=(text)=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text}]}]});
function fixture(task) {
  const [key,other]=task.byKey.keys(),{atoms}=task.layouts.get(key);
  const value={tail:'を使う。'};
  // Natural Japanese order: sx -> x -> reference -> literal model identifier.
  for(const [i,atom]of atoms.entries())value[atom.key]={o:i===0?1:i===1?0:i,t:i===0?'から画像':i===1?'ベクトル':i===2?'を再構成する':'。モデル'};
  return {[key]:value,[other]:'概要'};
}

test('required nodes reassemble reordered Japanese with exact math, reference and model identifier originals',async()=>{
  const source=pages(),task=await buildNodeTask(source,['a','b'],'English','Japanese'),value=fixture(task);
  const out=task.parse(body(JSON.stringify(value))),text=out.get('a');
  assert.match(text,/ベクトル<m_.*\/>から画像<m_.*\/>を再構成する\[13\]。モデルRN152を使う。/);
  assert.deepEqual(protectedRuns(text,source[0].blocks[0].mathSpans).filter(p=>p.math).map(p=>p.math.text),['sx','x']);
  assert.equal(task.schema.properties[[...task.byKey.keys()][0]].properties.a0.properties.o.minimum,undefined);
  assert.equal(task.input.pages[0].blocks[0].source_parts.filter(p=>p.atom).length,4);
});

test('missing, foreign and duplicate nodes, invalid permutations, free identifiers and reconstructed formulas are withheld',async()=>{
  const task=await buildNodeTask(pages(),['a','b'],'English','Japanese'),[key]=task.byKey.keys();
  const changes=[v=>{delete v.a0;},v=>{v.a4=v.a0;},v=>{v.a1.o=v.a0.o;},v=>{v.a0.o=9;},v=>{v.a0.o=.5;},v=>{v.a0.t='モデルRN151';},v=>{v.tail='追加<m_dead/>結果';},v=>{v.tail='数式$y$';},v=>{v.tail='追加α';},v=>{v.tail='\t翻訳';},v=>{v.a0.extra='bad';}];
  for(const change of changes){const all=fixture(task);change(all[key]);assert.throws(()=>task.parse(body(JSON.stringify(all))),e=>e instanceof MissingTranslationsError&&e.missingIds[0]==='a'&&e.partialTranslations.get('b')==='概要');}
  const all=fixture(task);all[key].tail='';for(const a of Object.keys(all[key]).filter(k=>k!=='tail'))all[key][a].t='';
  assert.throws(()=>task.parse(body(JSON.stringify(all))),MissingTranslationsError);
});

test('nested and escaped duplicate JSON keys never become safe previews or final output',async()=>{
  for(const text of ['{"x":{"o":0,"o":1}}','{"x":{"o":0,"\\u006f":1}}','{"x":[],"x":{}}'])assert.throws(()=>strictJson(text));
  const task=await buildNodeTask(pages(),['a','b'],'English','Japanese'),value=fixture(task),raw=JSON.stringify(value).replace('"o":1','"o":1,"o":0');
  const shown=[],collector=task.collector((...args)=>shown.push(args));collector.append(raw);
  assert.equal(shown.length,0);
  assert.throws(()=>task.parse(body(raw)),/形式/);
});

test('each completed block is the streaming unit, with robust quotes, escapes and split boundaries',()=>{
  const value={one:{a:{o:0,t:'引用 " } \\ 日本語'},tail:''},two:'概要'},text=JSON.stringify(value);
  for(let split=1;split<text.length;split++){
    const seen=[],collector=jsonMembers(i=>seen.push(i));collector.append(text.slice(0,split));collector.append(text.slice(split));
    assert.deepEqual(collector.finish().map(i=>i.value),Object.values(value));assert.equal(seen.length,2);
  }
  for(const text of ['[]','{"x":{}} tail','{"x":{},}','{"x":42}']){const c=jsonMembers();c.append(text);assert.throws(()=>c.finish());}
});

test('the real streaming client exposes a node block only when all its fields are complete and validated',async(t)=>{
  const stream=streamFixture();let request;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{request=JSON.parse(init.body);return stream.response;});
  const shown=[],pending=createNodeGeminiTranslator(options).translateDocument(pages(),['a','b'],(...args)=>shown.push(args));
  await until(()=>!!request);
  const [key,other]=request.response_format.schema.required;
  stream.start();stream.text('{"'+key+'":{"a0":{"o":0,"t":"画像"}');
  await new Promise(setImmediate);assert.equal(shown.length,0);
  stream.text(',"a1":{"o":1,"t":"をベクトル"},"a2":{"o":2,"t":"から再構成する"},"a3":{"o":3,"t":"。モデル"},"tail":"を使う。"},"'+other+'":"概要"}');
  await until(()=>shown.length===2);stream.complete();
  const result=await pending;assert.equal(result.size,2);assert.match(result.get('a'),/RN152/);
});

test('original retention and cancellation work without an alternate API path',async(t)=>{
  const source=pages();source[0].blocks[0].mathUncertain=true;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{const r=JSON.parse(init.body);return response({[r.response_format.schema.required[0]]:'概要'});});
  const out=await createNodeGeminiTranslator(options).translateDocument(source,['a','b']);assert.equal(out.get('a'),null);
  const controller=new AbortController();controller.abort();
  await assert.rejects(createNodeGeminiTranslator({...options,signal:controller.signal}).translateDocument(pages(),['a']),{name:'AbortError'});
});

test('node prompt asks for a whole natural translation and never asks for tag copying or fixed source order',()=>{
  const prompt=nodePrompt('- Write every mathematical expression as inline LaTeX.\n- The text was extracted from PDF.', 'English','Japanese');
  assert.match(prompt,/WHOLE/);assert.match(prompt,/unique Japanese occurrence rank/);assert.ok(!prompt.includes('as inline LaTeX'));
});

test('a numeric scalar copied into prose cannot be inserted again as original math',async()=>{
  const text='We use a drop-path probability of 0.25 and weight decay of 0.04.',a=text.indexOf('0.25'),b=text.indexOf('0.04');
  const source=[{page:1,blocks:[{id:'a',text,kind:'paragraph',mathSpans:[{start:a,end:a+4,text:'0.25'},{start:b,end:b+4,text:'0.04'}]}]}];
  const task=await buildNodeTask(source,['a'],'English','Japanese'),[key]=task.byKey.keys();
  const valid={a0:{o:0,t:'ドロップパス確率を'},a1:{o:1,t:'、重み減衰を'},tail:'とする。'};
  assert.equal(task.decode(key,valid).issue,null);
  for(const value of [{...valid,a0:{o:0,t:'0.25のドロップパス確率'}},{...valid,tail:'とし、0.04を使う。'}]){
    const c=task.collector(()=>assert.fail('invalid scalar must not preview'));c.append(JSON.stringify({[key]:value}));c.finish();
    assert.throws(()=>task.parse(body(JSON.stringify({[key]:value}))),MissingTranslationsError);
  }
  const repeated='We use 0.25 twice, at probability 0.25.';
  const again=await buildNodeTask([{page:1,blocks:[{id:'b',text:repeated,kind:'paragraph'}]}],['b'],'English','Japanese'),[other]=again.byKey.keys();
  // Do not compare all free-prose numbers: "twice" may naturally become 2回.
  assert.equal(again.decode(other,'確率0.25で0.25を2回使用する。').issue,null);
  assert.equal(again.decode(other,'確率0.25で0.25を二度使用する。').issue,null);
});

test('registered integer values do not collide with twice and decimal commas stay separators',async()=>{
  const text='We repeat the operation twice using a tensor of rank 2.',at=text.indexOf('2');
  const t=await buildNodeTask([{page:1,blocks:[{id:'a',text,kind:'paragraph',mathSpans:[{start:at,end:at+1,text:'2'}]}]}],['a'],'English','Japanese'),[key]=t.byKey.keys();
  assert.equal(t.decode(key,{a0:{o:0,t:'階数'},tail:'のテンソルを用いて処理を2回繰り返す。'}).issue,null);
  const scalar='We use 0.25 and 0.04.';
  const s=await buildNodeTask([{page:1,blocks:[{id:'b',text:scalar,mathSpans:[{start:7,end:11,text:'0.25'},{start:16,end:20,text:'0.04'}]}]}],['b'],'English','Japanese'),[other]=s.byKey.keys();
  assert.equal(s.decode(other,{a0:{o:0,t:'設定値は'},a1:{o:1,t:','},tail:'である。'}).issue,null);
  assert.equal(s.decode(other,{a0:{o:0,t:'設定値は'},a1:{o:1,t:'、'},tail:'である。別の表記では0.25,0.04である。'}).issue,'node');
});

test('an atom-only name can remain unchanged but normalized extra identifiers are rejected',async()=>{
  const task=await buildNodeTask([{page:1,blocks:[{id:'name',text:'ImageNet-1K',kind:'other'}]}],['name'],'English','Japanese');
  const [key]=task.byKey.keys(),value={a0:{o:0,t:''},tail:''};
  assert.equal(task.parse(body(JSON.stringify({[key]:value}))).get('name'),'ImageNet-1K');
  for(const extra of ['はＲＮ１５１である。','はRN₁₅₁である。']){
    assert.throws(()=>task.parse(body(JSON.stringify({[key]:{...value,tail:extra}}))),MissingTranslationsError);
  }
});

test('normalized source names retain original spelling and literal boundaries cannot grow new identifiers',async()=>{
  for(const name of ['RN152','ＲＮ１５２','RN₁₅₂','ﬀ12']){
    const task=await buildNodeTask([{page:1,blocks:[{id:'a',text:`We use ${name}.`,kind:'paragraph'}]}],['a'],'English','Japanese'),[key]=task.byKey.keys();
    assert.equal(task.parse(body(JSON.stringify({[key]:{a0:{o:0,t:'モデル'},tail:'を使う。'}}))).get('a'),`モデル${name}を使う。`);
    for(const [t,tail]of [['モデル','1を使う。'],['モデルRN','を使う。']])assert.throws(()=>task.parse(body(JSON.stringify({[key]:{a0:{o:0,t},tail}}))),MissingTranslationsError);
  }
});

test('scientific coefficients stay attached to exponents and percentage names form one original node',async()=>{
  const text='Use 3e−5 on ImageNet-1%.';
  const task=await buildNodeTask([{page:1,blocks:[{id:'a',text,mathSpans:[{start:6,end:8,text:'−5'}]}]}],['a'],'English','Japanese');
  const [key]=task.byKey.keys(),atoms=task.layouts.get(key).atoms;
  assert.deepEqual(atoms.map(a=>a.source),['3e−5','ImageNet-1%']);
  const out=task.parse(body(JSON.stringify({[key]:{a0:{o:1,t:'に'},a1:{o:0,t:''},tail:'を使う。'}}))).get('a');
  assert.match(out,/^ImageNet-1%に3e<m_.*\/>を使う。$/);
});

test('author and bibliography prose can retain names instead of being forced into Japanese script',async()=>{
  const task=await buildNodeTask([{page:1,blocks:[{id:'a',text:'Mahmoud Assran [1]',kind:'paragraph'}]}],['a'],'English','Japanese'),[key]=task.byKey.keys();
  assert.equal(task.parse(body(JSON.stringify({[key]:{a0:{o:0,t:'Mahmoud Assran '},tail:''}}))).get('a'),'Mahmoud Assran [1]');
});
