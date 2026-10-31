import test from 'node:test';
import assert from 'node:assert/strict';
import { productionCase, mapPanel } from '../scripts/evaluation/compare-inputs.mjs';
import { legacyRequest } from '../scripts/evaluation/legacy-format.mjs';

test('current request separates exact targets from full context and keeps layout coordinates local', async () => {
  const pages = [
    { page: 1, blocks: [
      { id: 'p1-b0', text: 'Figure reference only', kind: 'other', translate: false },
      { id: 'p1-b1', text: 'Table 3. Full caption and body.', kind: 'caption', bbox: [50,100,280,170], translate: true },
    ] },
    { page: 2, blocks: [{ id: 'p2-b5', text: '2. Background', kind: 'heading', translate: true }] },
  ];
  const variant = await productionCase(pages), input = JSON.parse(variant.request.input);
  assert.deepEqual(input.pages, [
    { page: 1, text: 'Figure reference only\n\nTable 3. Full caption and body.' },
    { page: 2, text: '2. Background' },
  ]);
  assert.deepEqual(input.targets, [
    { id: 1, page: 1, kind: 'caption', text: 'Table 3. Full caption and body.' },
    { id: 2, page: 2, kind: 'heading', text: '2. Background' },
  ]);
  assert.equal(input.translate_count, 2);
  assert.equal(variant.targets[1].id, 'p2-b5');
  assert.doesNotMatch(variant.request.input, /bbox|translate_id|p1-b/);
  assert.match(variant.request.system_instruction, /intentional duplication, not an additional task/);
  assert.equal(variant.request.stream, true);
  assert.deepEqual(Object.keys(variant.request.response_format.schema.properties.translations.items.properties), ['id','text']);
});

test('historical baseline remains the sequential mixed-block format', () => {
  const request = legacyRequest([{page:1,blocks:[{id:'a',text:'Reference'},{id:'b',text:'Target'}]}],['b']);
  const input = JSON.parse(request.input);
  assert.deepEqual(input.pages[0].blocks,[{text:'Reference'},{translate_id:1,text:'Target'}]);
  assert.match(request.system_instruction,/integer "translate_id"/);
  assert.equal(input.targets,undefined);
});

test('semantic panel prefers an exact label over a paragraph mentioning it', () => {
  const panel = mapPanel([{id:'p1-b12',page:1,text:'Abstract'}],[
    {id:'p1-b4',page:1,text:'The abstract representation is learned.'},
    {id:'p1-b3',page:1,text:'Abstract'},
  ]);
  assert.equal(panel.find((entry)=>entry.original==='p1-b12').candidate,'p1-b3');
});
