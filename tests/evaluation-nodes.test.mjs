import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNodes,analyzeNodes,replayNodes } from '../scripts/evaluation/node-format.mjs';

test('evaluation captures the real node schema and replays whole-block guards without a live request',async()=>{
  const pages=[{page:1,blocks:[{id:'a',translate:true,kind:'paragraph',text:'Use RN152 according to prior work [4].'},
    {id:'b',translate:true,mathUncertain:true,text:'Uncertain source expression'}]}];
  const candidate=await captureNodes(pages),[target]=candidate.targets;
  assert.equal(candidate.targets.length,1);assert.deepEqual(candidate.originals.map(t=>t.id),['b']);
  assert.equal(target.sourceParts.filter(p=>p.atom).length,2);
  const text=JSON.stringify({[target.wire]:{a0:{o:1,t:'に従い'},a1:{o:0,t:'先行研究'},tail:'を使用する。'}});
  assert.equal(analyzeNodes(candidate,text,'completed').valid,true);
  const out=await replayNodes(pages,{status:'completed',outputText:text});
  assert.equal(out.accepted,true);assert.equal(out.translated.a,'先行研究[4]に従いRN152を使用する。');assert.equal(out.translated.b,null);
  assert.equal(analyzeNodes(candidate,text.slice(0,-1),'completed').valid,false);
  assert.equal(analyzeNodes(candidate,text,'incomplete').valid,false);
  const invalid=await replayNodes(pages,{status:'completed',outputText:JSON.stringify({[target.wire]:{a0:{o:0,t:'モデル'},tail:'である。'}})});
  assert.equal(invalid.accepted,false);assert.equal(invalid.issues[0].reason,'node');
});

test('flat evaluation counts fields separately from blocks and replays the real flat codec',async()=>{
  const pages=[{page:1,blocks:[{id:'a',text:'We use RN152 [4].',kind:'paragraph',translate:true},{id:'b',text:'Abstract',kind:'heading',translate:true}]}];
  const candidate=await captureNodes(pages,{flat:true}),blocks=JSON.parse(candidate.request.input).pages[0].blocks;
  const a=blocks[0],b=blocks[1],atoms=a.source_parts.filter(p=>p.atom);
  const text=JSON.stringify({[atoms[0].field]:'0:モデル',[atoms[1].field]:'1:を使う',[a.tail_field]:'。',[b.whole_field]:'概要'});
  assert.equal(analyzeNodes(candidate,text,'completed').valid,true);
  assert.equal(analyzeNodes(candidate,text,'completed').expected,4);
  const out=await replayNodes(pages,{status:'completed',outputText:text},{flat:true});
  assert.equal(out.accepted,true);assert.equal(out.translated.a,'モデルRN152を使う[4]。');
  const missing=JSON.parse(text);delete missing[atoms[0].field];
  assert.equal(analyzeNodes(candidate,JSON.stringify(missing),'completed').missing,1);
});

test('compact evaluation keeps one required field per block and checks records through the real codec',async()=>{
  const pages=[{page:1,blocks:[{id:'a',text:'We use RN152 following prior work [4].',translate:true},{id:'b',text:'Abstract',kind:'heading',translate:true}]}];
  const candidate=await captureNodes(pages,{compact:true}),[a,b]=candidate.targets;
  assert.equal(candidate.request.response_format.schema.required.length,2);
  const raw=JSON.stringify({[a.wire]:'1:に従い\n0:先行研究\nを使う。',[b.wire]:'概要'});
  assert.equal(analyzeNodes(candidate,raw,'completed').valid,true);
  assert.equal((await replayNodes(pages,{status:'completed',outputText:raw},{compact:true})).translated.a,'先行研究[4]に従いRN152を使う。');
});
