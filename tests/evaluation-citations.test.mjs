import test from 'node:test';
import assert from 'node:assert/strict';
import { citationVariants, restoreCitations, citationMetrics } from '../scripts/evaluation/citation-formats.mjs';
import { captureCurrent } from '../scripts/evaluation/reproduce-current.mjs';
import { analyze } from '../scripts/evaluation/compare-formats.mjs';

const pages = [{ page: 1, blocks: [
  { id: 'p1-b0', text: 'Context only [90].', translate: false },
  { id: 'p1-b1', text: 'Prior work [4, 5, 18] uses this [4, 5, 18].', kind: 'paragraph', translate: true },
  { id: 'p1-b2', text: 'Another example [2–4].', kind: 'paragraph', translate: true },
] }];

test('baseline is byte-identical to the viewer; explicit mode changes only instructions', async () => {
  const cases = await citationVariants(pages), current = await captureCurrent(pages);
  assert.deepEqual(cases.B.request, current.request);
  assert.equal(cases.P.request.input, cases.B.request.input);
  assert.deepEqual(cases.P.request.generation_config, cases.B.request.generation_config);
  assert.equal(cases.P.request.model, cases.B.request.model);
  const descriptions = Object.values(cases.P.request.response_format.schema.properties);
  assert.ok(descriptions[0].description.includes(JSON.stringify(['[4, 5, 18]', '[4, 5, 18]'])));
  assert.ok(descriptions[1].description.includes('[2–4]'));
});

test('masked mode protects context and every reference occurrence without losing duplicates or ranges', async () => {
  const { M } = await citationVariants(pages);
  assert.equal(Object.keys(M.markers).length, 4);
  const input = JSON.parse(M.request.input);
  assert.ok(!input.pages[0].blocks[0].text.includes('[90]'));
  const raw = Object.fromEntries(M.targets.map((target) => [target.id, '訳 ' + target.maskedText]));
  const decoded = restoreCitations(M, raw);
  assert.deepEqual(decoded.markerFailures, []);
  assert.equal(decoded.translated['p1-b1'], '訳 ' + pages[0].blocks[1].text);
  assert.equal(decoded.translated['p1-b2'], '訳 ' + pages[0].blocks[2].text);
});

test('masked decoding refuses missing, duplicated, foreign, reordered and damaged markers', async () => {
  const { M } = await citationVariants(pages), first = M.targets[0];
  const markers = first.maskedText.match(/\[\[REF_[a-f0-9]+\]\]/g);
  for (const text of [
    '引用なし', markers[0], markers.join(' ') + ' ' + markers[0],
    markers.join(' ') + ' [[REF_deadbeef]]', [...markers].reverse().join(' '),
    first.maskedText.replace('[[REF_', '[[REF_CHANGED_'),
  ]) {
    const decoded = restoreCitations(M, { [first.id]: text });
    assert.equal(decoded.markerFailures.length, 1);
    assert.equal(Object.hasOwn(decoded.translated, first.id), false);
  }
});

test('all-page metrics keep production reference and heading checks after decoding', async () => {
  const { P, M } = await citationVariants(pages);
  const result = (candidate, translated) => {
    const text = JSON.stringify(Object.fromEntries(candidate.targets.map((target) => [target.wire, translated[target.id]])));
    return { analysis: analyze(candidate, text, 'completed') };
  };
  const plain = result(P, { 'p1-b1': '訳 [4,5,18] [4,5,18]', 'p1-b2': '訳 [2,3,4]' });
  assert.equal((await citationMetrics(pages, P, plain)).guardPass, true);
  const wrong = result(P, { 'p1-b1': '番号欠落', 'p1-b2': '訳 [2,3,4]' });
  assert.equal((await citationMetrics(pages, P, wrong)).guardPass, false);
  const masked = result(M, Object.fromEntries(M.targets.map((target) => [target.id, '訳 ' + target.maskedText])));
  assert.equal((await citationMetrics(pages, M, masked)).guardPass, true);
});
