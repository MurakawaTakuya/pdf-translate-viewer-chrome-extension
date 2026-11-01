import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFlatNodeTask,createFlatNodeGeminiTranslator,flatNodePrompt} from '../flat-node-translations.js';
import {MissingTranslationsError} from '../gemini.js';
import {streamFixture,until} from './helpers/stream.mjs';

const pages=()=>[{page:1,blocks:[{id:'a',kind:'paragraph',text:'The model RN152 is used following prior work [4].'},{id:'b',kind:'heading',text:'Abstract'}]}];
const body=text=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text}]}]});
function fixture(task){
  const [block,other]=task.byKey.keys(),[name,ref,tail]=task.byBlock.get(block),[whole]=task.byBlock.get(other);
  return {[name]:'1:に従いモデル',[ref]:'0:先行研究',[tail]:'を使う。',[whole]:'概要'};
}
test('a shallow required string schema preserves atom identity and natural reordering',async()=>{
  const task=await buildFlatNodeTask(pages(),['a','b'],'English','Japanese'),out=task.parse(body(JSON.stringify(fixture(task))));
  assert.equal(out.get('a'),'先行研究[4]に従いモデルRN152を使う。');
  assert.ok(Object.values(task.schema.properties).every(p=>p.type==='string'&&!p.properties&&!p.enum&&!p.pattern));
  assert.deepEqual(task.schema.required,Object.keys(task.schema.properties));
  assert.equal(task.fields.size,4);
  assert.ok(task.input.pages[0].blocks[0].source_parts.filter(p=>p.atom).every(p=>task.fields.has(p.field)));
});
test('rank parsing is exact, uses only the first colon, and withholds invalid or missing fields atomically',async()=>{
  const task=await buildFlatNodeTask(pages(),['a','b'],'English','Japanese'),[key]=task.byKey.keys(),[name,ref]=task.byBlock.get(key);
  for(const value of ['-1:訳','01:訳','１:訳','1：訳','1.0:訳','1e0:訳','9007199254740993:訳','3:訳']){
    const out=fixture(task);out[name]=value;assert.throws(()=>task.parse(body(JSON.stringify(out))),e=>e instanceof MissingTranslationsError&&e.missingIds[0]==='a'&&e.partialTranslations.get('b')==='概要');
  }
  const missing=fixture(task);delete missing[name];assert.throws(()=>task.parse(body(JSON.stringify(missing))),MissingTranslationsError);
  const dup=fixture(task);dup[name]='0:モデル';assert.throws(()=>task.parse(body(JSON.stringify(dup))),MissingTranslationsError);
  const okay=fixture(task);okay[ref]='0:注:説明\n先行研究';assert.match(task.parse(body(JSON.stringify(okay))).get('a'),/^注:説明\n先行研究/);
});
test('streaming waits for every field of the block and final duplicate keys fail',async(t)=>{
  let request;const stream=streamFixture();
  t.mock.method(globalThis,'fetch',async(_url,init)=>{request=JSON.parse(init.body);return stream.response;});
  const shown=[],pending=createFlatNodeGeminiTranslator({apiKey:'fixture',sourceLanguage:'en',targetLanguage:'ja'}).translateDocument(pages(),['a','b'],(...a)=>shown.push(a));
  await until(()=>!!request);
  const [name,ref,tail,whole]=request.response_format.schema.required;
  stream.start();stream.text(JSON.stringify({[name]:'1:に従いモデル',[ref]:'0:先行研究'}).slice(0,-1));
  await new Promise(setImmediate);assert.equal(shown.length,0);
  stream.text(',"'+tail+'":"を使う。","'+whole+'":"概要"}');
  await until(()=>shown.length===2);stream.complete();assert.equal((await pending).size,2);
  const task=await buildFlatNodeTask(pages(),['a','b'],'English','Japanese'),text=JSON.stringify(fixture(task)).replace(/^{/,'{"'+[...task.fields.keys()][0]+'":"0:",');
  assert.throws(()=>task.parse(body(text)),/形式/);
});
test('flat instructions fully replace the nested node format',()=>{
  const prompt=flatNodePrompt('- Return a JSON object with translations.\n- Write every mathematical expression as inline LaTeX.\n- The text was extracted from PDF.','English','Japanese');
  assert.match(prompt,/first colon/);assert.match(prompt,/Never return nested objects/);assert.ok(!prompt.includes('{"o"'));assert.ok(!prompt.includes('as inline LaTeX'));
});
