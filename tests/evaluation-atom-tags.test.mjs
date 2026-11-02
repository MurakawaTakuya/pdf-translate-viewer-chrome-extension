import test from 'node:test';
import assert from 'node:assert/strict';
import {captureAtomTags,replayAtomTags} from '../scripts/evaluation/atom-tags.mjs';

test('the evaluated request uses the real tag factory and decoder with fixed originals',async()=>{
  const pages=[{page:1,blocks:[{id:'a',kind:'paragraph',text:'The model RN152 uses prior work [4].',translate:true},{id:'b',text:'Abstract',kind:'heading',translate:true},{id:'c',text:'Uncertain formula',mathUncertain:true,translate:true}]}];
  const candidate=await captureAtomTags(pages),[model,ref]=candidate.targets[0].sourceAtoms.map(a=>a.tag);
  assert.equal(candidate.targets.length,2);assert.equal(candidate.originals[0].id,'c');
  const output={[candidate.targets[0].wire]:`モデル${model}は先行研究${ref}を使う。`,[candidate.targets[1].wire]:'概要'};
  const decoded=await replayAtomTags(pages,{status:'completed',outputText:JSON.stringify(output)});
  assert.equal(decoded.accepted,true);assert.equal(decoded.translated.a,'モデルRN152は先行研究[4]を使う。');assert.equal(decoded.translated.c,null);
});
