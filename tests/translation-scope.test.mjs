import test from 'node:test';
import assert from 'node:assert/strict';
import {excludeReferences,loadTranslationBlocks} from '../translation-scope.js';
const block=(text,kind='paragraph')=>({text,kind,translate:true});

test('references span pages, while subsequent appendix headings resume translation',()=>{
  const first=[block('Our conclusions.'),block('References','heading'),block('[1] A paper title.','paragraph')];
  const second=[block('[2] The next paper.'),block('[3] More references.')];
  const third=[block('[4] Last entry.'),block('A. Implementation Details A.1. Pretraining','heading'),block('We train our model.')];
  const state=excludeReferences(first);assert.equal(state,true);assert.equal(first[0].translate,true);assert.equal(first[1].translate,false);
  assert.equal(excludeReferences(second,state),true);assert.ok(second.every(b=>b.translate===false));
  assert.equal(excludeReferences(third,true),false);assert.deepEqual(third.map(b=>b.translate),[false,true,true]);
  assert.equal(first[2].text,'[1] A paper title.');
});

test('mentions of references in ordinary prose do not start an exclusion',()=>{
  const blocks=[block('References'),block('References are provided for reproducibility.'),block('We refer to the bibliography.'),block('10. Results','heading')];
  assert.equal(excludeReferences(blocks),false);assert.ok(blocks.every(b=>b.translate));
  const multilingual=[block('参考文献','heading'),block('研究のタイトル'),block('Supplementary Material','heading'),block('More experiments.')];
  assert.equal(excludeReferences(multilingual),false);assert.deepEqual(multilingual.map(b=>b.translate),[false,false,true,true]);
});

test('numbered references start a section, while author initials do not end it',()=>{
  const blocks=[block('7.1 References','heading'),block('A. Smith and B. Jones. A New Method.','heading'),block('Another reference.'),block('A Additional Experiments','heading'),block('Appendix prose.')];
  assert.equal(excludeReferences(blocks),false);assert.deepEqual(blocks.map(b=>b.translate),[false,false,false,true,true]);
  const label=[{...block('References','heading'),translationSkip:'figure'},block('Body text below a figure.')];
  assert.equal(excludeReferences(label),false);assert.equal(label[1].translate,true);
  const continuation=[{...block('A. Methods','heading'),translationSkip:'figure'},block('[21] Bibliographic title.')];
  assert.equal(excludeReferences(continuation,true),true);assert.ok(continuation.every(b=>b.translate===false));
});

test('jumping directly to a reference continuation shares extraction and applies previous-page state',async()=>{
  const rows=[{index:1},{index:2},{index:3}],calls=[];
  const extract=async row=>{calls.push(row.index);return row.index===1?[block('References','heading')]:row.index===2?[block('[12] An untranslated original title.')]:[block('B. More Experiments','heading'),block('New results.')];};
  const [first,second]=await Promise.all([loadTranslationBlocks(rows[1],rows,extract),loadTranslationBlocks(rows[1],rows,extract)]);
  assert.equal(first,second);assert.deepEqual(calls,[1,2]);assert.equal(first[0].translate,false);
  assert.ok((await loadTranslationBlocks(rows[2],rows,extract)).every(b=>b.translate));
});

test('an extraction failure can be retried without caching an incomplete reference state',async()=>{
  const rows=[{}];let calls=0;const extract=async()=>{if(++calls===1)throw new Error('temporary');return[block('References','heading')];};
  await assert.rejects(loadTranslationBlocks(rows[0],rows,extract),/temporary/);
  assert.equal(rows[0].blocks,undefined);assert.equal((await loadTranslationBlocks(rows[0],rows,extract))[0].translate,false);
});
