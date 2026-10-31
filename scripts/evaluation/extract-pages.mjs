// Read-only extraction using the same layout implementation as the viewer.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from '../../lib/pdf.min.mjs';
import { extractBlocks } from '../../pdf-layout.js';

export async function extractPages(path) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../lib/pdf.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await readFile(path)), disableFontFace: true, isEvalSupported: false }).promise;
  try {
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      await page.getOperatorList();
      const blocks = await extractBlocks({ page, vp: page.getViewport({ scale: 1 }) });
      pages.push({ page: index, blocks: blocks.map((b, i) => ({ id: `p${index}-b${i}`, text: b.text, kind: b.kind, translate: b.translate,
        bbox: [b.x0, b.top, b.x1, b.bottom], fontSize: b.h, lines: b.lines.length })) });
    }
    return pages;
  } finally { await pdf.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/evaluation/extract-pages.mjs input.pdf output.json');
  const pages = await extractPages(process.argv[2]);
  await writeFile(process.argv[3], JSON.stringify(pages, null, 2));
  console.log(JSON.stringify({ pages: pages.length, targets: pages.flatMap((p) => p.blocks.filter((b) => b.translate)).length,
    perPage: pages.map((p) => ({ page: p.page, blocks: p.blocks.length, targets: p.blocks.filter((b) => b.translate).length })) }));
}
