import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from '../lib/pdf-lib.esm.min.js';
import * as pdfjs from '../lib/pdf.min.mjs';

globalThis.self = globalThis;
globalThis.fontkit = (await import('../lib/fontkit.umd.min.js')).default;
const { exportPdf } = await import('../export.js');
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1kAAAAASUVORK5CYII=';

test('saved protected math crops do not duplicate unrelated source-page text or leak marker syntax', async (t) => {
  t.mock.method(globalThis, 'fetch', async (path) => new Response(await readFile(new URL('../' + path, import.meta.url))));
  const doc = await PDFDocument.create(), page = doc.addPage([300,300]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  page.drawText('UNRELATED_SOURCE_SENTENCE', { x:10,y:250,size:10,font });
  page.drawText('x', { x:10,y:200,size:10,font });
  const span = { id:'m_abcd',text:'x',x0:10,x1:18,top:90,bottom:102,base:100,h:10,imageUrl:png,imageScale:3 };
  const block = { x0:10,x1:200,top:90,bottom:120,h:10,colors:{bg:[255,255,255],fg:[0,0,0]},
    ja:'TEST <m_abcd/> AGAIN <m_abcd/> END',mathSpans:[span] };
  const viewport = { scale:1,convertToPdfPoint:(x,y)=>[x,300-y] };
  const result = await exportPdf('ja',await doc.save(),[{index:1,vp:viewport,blocks:[block]}]);
  const pdf = await pdfjs.getDocument({data:result,disableFontFace:true,isEvalSupported:false}).promise;
  try {
    const outputPage = await pdf.getPage(1), text = (await outputPage.getTextContent()).items.map(i=>i.str).join(' ');
    assert.equal(text.match(/UNRELATED_SOURCE_SENTENCE/g)?.length,1);
    assert.ok(text.includes('TEST'));
    assert.ok(!text.includes('m_abcd'));
  } finally { await pdf.destroy(); }
});
