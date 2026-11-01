import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBlocks } from '../pdf-layout.js';

const item = (str, x, y, width = str.length * 4, font = 'regular', size = 10) => ({
  str, width, fontName: font, transform: [size, 0, 0, size, x, y],
});
async function extract(items) {
  return extractBlocks({ vp: { width: 600, scale: 1, transform: [1, 0, 0, 1, 0, 0] }, page: {
    getTextContent: async () => ({ items, styles: { regular: {}, bold: {} } }),
    commonObjs: { has: () => true, get: (name) => ({ name: ({ bold: 'Times-Bold', math: 'CMMI10', roman: 'CMR10', boldmath: 'CMMIB10' })[name] || 'Times-Roman', ascent: 0.8, descent: -0.2 }) },
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

test('a TeX overprinted hat and base glyph remain one line and retain original glyph ranges', async () => {
  const blocks = await extract([
    item('The objective uses ', 50, 100, 240), item('h', 292, 100, 6, 'math'),
    item('( ˆ', 300, 100, 10, 'roman'), item('x', 304, 100, 7, 'boldmath'),
    item(') and a complete sentence.', 312, 100, 190),
    item('The same paragraph continues on this line.', 50, 112, 450),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 2);
  assert.match(blocks[0].text, /h ?\( ˆx\)/);
  for (const part of blocks[0].parts) assert.equal(blocks[0].text.slice(part.start, part.end), part.str);
  assert.equal(blocks[0].parts.find((part) => part.str === 'x').fi.bold, true);
});

test('overlap without a mathematical accent is not merged into a single line', async () => {
  const blocks = await extract([
    item('Separate overlapping text', 50, 100, 200),
    item('Another text region', 100, 100, 200),
  ]);
  assert.equal(blocks.length, 2);
});

test('hat overlap stays narrow and keeps a separate column or differently aligned run out', async () => {
  for (const next of [item('ordinary prose', 304, 100, 80), item('manyvariables', 304, 100, 200, 'math'),
    item('x', 304, 104, 7, 'math'), item('x', 298, 100, 7, 'math')]) {
    const blocks = await extract([item('Prefix ( ˆ', 50, 100, 260, 'roman'), next]);
    assert.equal(blocks.length, 2);
  }
  const reversed = await extract([item('A math variable ', 50, 100, 240), item('x', 292, 100, 7, 'math'), item('ˆ', 294, 100, 5, 'roman')]);
  assert.equal(reversed.length, 1);
});

test('source offsets explicitly retain the trimmed glyph slice and ordinary line separators', async () => {
  const blocks = await extract([item('  Leading ', 50, 100, 100), item('word  ', 152, 100, 100),
    item('second line text  ', 50, 112, 200)]);
  assert.equal(blocks.length, 1);
  for (const part of blocks[0].parts) {
    assert.equal(blocks[0].text.slice(part.start, part.end), part.str.slice(part.sourceStart, part.sourceEnd));
    assert.ok(part.start >= 0 && part.end <= blocks[0].text.length);
  }
});
