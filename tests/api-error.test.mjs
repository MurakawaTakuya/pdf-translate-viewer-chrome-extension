import test from 'node:test';
import assert from 'node:assert/strict';
import { readApiError } from '../api-error.js';
import { createKeyedGeminiTranslator } from '../gemini.js';
import { generate } from '../scripts/evaluation/compare-formats.mjs';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const error={code:400,status:'INVALID_ARGUMENT',message:'Synthetic schema failure',details:[{retryDelay:'3s'}]};
const sse=(e)=>'event: error\ndata: '+JSON.stringify({event_type:'error',error:e})+'\n\n';
test('HTTP error decoding preserves JSON, array and SSE messages and retry details',async()=>{
  for(const text of [JSON.stringify({error}),JSON.stringify([{error}]),sse(error),sse(error).replaceAll('\n','\r\n')]){
    assert.deepEqual(await readApiError(new Response(text,{status:400})),error);
  }
  const out=await readApiError(new Response('<html>not an API error</html>',{status:400}));
  assert.match(out.message,/解析できません/);assert.ok(!out.message.includes('<html>'));
});

test('the actual client reports SSE HTTP 400 without retrying and redacts the key',async(t)=>{
  let calls=0;const apiKey='offline-fixture-key';
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(sse({...error,message:'Synthetic '+apiKey+' rejected'}),{status:400});});
  await assert.rejects(createKeyedGeminiTranslator({apiKey,sourceLanguage:'en',targetLanguage:'ja'}).translateDocument([{page:1,blocks:[{id:'a',text:'Abstract'}]}],['a']),e=>e.message.includes('400')&&e.message.includes('[redacted]')&&!e.message.includes(apiKey));
  assert.equal(calls,1);
});

test('the evaluator records an SSE HTTP failure instead of a JSON parser exception',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'pdf-node-api-error-'));
  const detailed={...error,details:[...error.details,{metadata:{reason:'fixture-key rejected'},'fixture-key':'private'}]};
  t.mock.method(globalThis,'fetch',async()=>new Response(sse(detailed),{status:400}));
  try{
    const out=await generate({name:'fixture',protocol:'keyed-object',targets:[],request:{model:'offline-fixture'}},'fixture-key','E1',directory);
    assert.equal(out.http,400);assert.equal(out.error.message,error.message);assert.equal(out.error.code,400);assert.equal(out.status,'no-completion');
    assert.equal(out.error.details[0].retryDelay,'3s');assert.equal(out.error.details[1].metadata.reason,'[redacted] rejected');
    assert.equal(out.error.details[1]['[redacted]'],'private');assert.ok(!JSON.stringify(out.error).includes('fixture-key'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
