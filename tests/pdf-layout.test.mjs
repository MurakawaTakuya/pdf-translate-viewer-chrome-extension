import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBlocks } from '../pdf-layout.js';

const item = (str, x, y, width = str.length * 4, font = 'regular', size = 10) => ({
  str, width, fontName: font, transform: [size, 0, 0, size, x, y],
});
async function extract(items) {
  return extractBlocks({ vp: { width: 600, scale: 1, transform: [1, 0, 0, 1, 0, 0] }, page: {
    getTextContent: async () => ({ items, styles: { regular: {}, bold: {} } }),
    commonObjs: { has: () => true, get: (name) => ({ name: name === 'bold' ? 'Times-Bold' : 'Times-Roman', ascent: 0.8, descent: -0.2 }) },
  } });
}

test('mixed bold caption lead-in joins its continuation and keeps the full display rectangle', async () => {
  const blocks = await extract([
    item('Table 3. Transfer performance.', 50, 100, 160, 'bold'),
    item('Linear-', 214, 100, 32),
    item('evaluation of the learned representations.', 50, 112, 210),
    item('Results on several downstream tasks.', 50, 124, 180),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'caption');
  assert.match(blocks[0].text, /Linear-evaluation/);
  assert.match(blocks[0].text, /downstream tasks/);
  assert.equal(blocks[0].bottom - blocks[0].top, 34);
});

test('pure bold heading stays separate from the regular paragraph', async () => {
  const blocks = await extract([
    item('2. Background', 50, 100, 100, 'bold'),
    item('Self-supervised learning studies representations.', 50, 112, 220),
    item('Its objective uses an unlabeled collection.', 50, 124, 210),
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks[1].lines.length, 2);
});

test('reading order ignores shuffled PDF drawing order and reads each column to the end', async () => {
  const fragments = [
    item('Left first line with words', 50, 100, 200), item('Left second line with words', 50, 112, 200),
    item('Right first line with words', 320, 100, 200), item('Right second line with words', 320, 112, 200),
  ];
  const blocks = await extract([fragments[3], fragments[0], fragments[2], fragments[1]]);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /^Left first.*Left second/);
  assert.match(blocks[1].text, /^Right first.*Right second/);
  assert.ok(blocks[0].x1 < blocks[1].x0);
});

test('full-width caption is read before the two columns below it', async () => {
  const blocks = await extract([
    item('Figure 2. This caption spans both columns of the paper.', 50, 80, 470),
    item('Left first line with words', 50, 120, 200), item('Right first line with words', 320, 120, 200),
    item('Left second line with words', 50, 132, 200), item('Right second line with words', 320, 132, 200),
  ].reverse());
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, 'caption');
  assert.match(blocks[1].text, /^Left first.*Left second/);
  assert.match(blocks[2].text, /^Right first.*Right second/);
});

test('adjacent numbered captions are not merged and rotated marginal text is excluded', async () => {
  const rotated = { ...item('arXiv marginal text', 20, 100), transform: [0, 10, -10, 0, 20, 100] };
  const blocks = await extract([
    item('Figure 1. First caption with words.', 50, 100, 250),
    item('Figure 2. Second caption with words.', 50, 112, 250), rotated,
  ]);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.kind === 'caption'));
});


test('inline bold lead-in stays with its paragraph, and a reference to a table is not a caption', async () => {
  const blocks = await extract([
    item('Transfer learning.', 50, 100, 80, 'bold'),
    item('Table 3 shows our results on several tasks.', 142, 100, 190),
    item('We adapt the pretrained model with a linear probe.', 50, 112, 280),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'paragraph');
  assert.match(blocks[0].text, /^Transfer learning. Table 3 shows/);
  assert.match(blocks[0].text, /linear probe/);
});
