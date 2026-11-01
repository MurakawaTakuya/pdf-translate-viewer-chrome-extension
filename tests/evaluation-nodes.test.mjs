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
