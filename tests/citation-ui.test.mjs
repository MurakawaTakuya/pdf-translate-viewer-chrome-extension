import test from 'node:test';
import assert from 'node:assert/strict';
import { createCitationDialog } from '../citation-ui.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(fileUrl = 'https://doi.org/10.1234/paper', overrides = {}) {
  const elements = new Map(), copied = [], downloads = [], calls = [];
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, open: false, style: {}, value: '', textContent: '', disabled: false,
      classList: { toggle() {} }, setAttribute() {}, focus() {},
      getBoundingClientRect: () => ({ bottom: 60 }),
      showModal() { this.open = true; }, close() { this.open = false; this.onclose?.(); },
    });
    return elements.get(id);
  };
  const service = {
    resolve: async (id) => { calls.push(id); return { doi: '10.1234/paper', title: 'Paper title', version: 'DOI登録情報' }; },
    formatted: async (_doi, style) => style + ' citation',
    exported: async (_doi, format) => format + ' source',
    ...overrides,
  };
  const controller = createCitationDialog({
    document: { querySelector: $ }, fileUrl, getPdf: () => ({}), service,
    clipboard: { writeText: async (text) => { copied.push(text); } },
    download: (text, filename) => { downloads.push({ text, filename }); },
  });
  return { $, controller, copied, downloads, calls };
}

test('citation panel fetches only on opening and supports three copies and reference exports', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  await f.controller.open();
  assert.equal(f.$('#citations').open, true);
  assert.equal(f.$('#citations').style.top, '68px');
  assert.equal(f.$('#citationContent').hidden, false);
  for (const style of ['mla', 'apa', 'iso']) {
    assert.equal(f.$(`#citation-${style}`).textContent, style + ' citation');
    await f.$(`#copy-${style}`).onclick();
  }
  assert.deepEqual(f.copied, ['mla citation', 'apa citation', 'iso citation']);
  for (const id of ['bibtex', 'endnote', 'refman', 'refworks']) {
    await f.$(`#export-${id}`).onclick();
    await f.$('#citationExportCopy').onclick();
    f.$('#citationExportSave').onclick();
  }
  assert.deepEqual(f.downloads.map((d) => d.filename), ['citation.bib', 'citation.ris', 'citation.ris', 'citation.ris']);
});

test('unknown PDFs require an identifier, with validation before service calls', async () => {
  const f = fixture('file:///unknown.pdf');
  await f.controller.open();
  assert.equal(f.calls.length, 0);
  assert.equal(f.$('#citationLookup').hidden, false);
  const submit = () => f.$('#citationLookup').onsubmit({ preventDefault() {} });
  f.$('#citationIdentifier').value = 'unknown';
  await submit();
  assert.equal(f.calls.length, 0);
  f.$('#citationIdentifier').value = '2301.08243';
  await submit();
  assert.deepEqual(f.calls, [{ type: 'arxiv', value: '2301.08243' }]);
  assert.equal(f.$('#citationContent').hidden, false);
});

test('closing a panel prevents late metadata from revealing stale content', async () => {
  const pending = deferred();
  const f = fixture(undefined, { resolve: () => pending.promise });
  const opening = f.controller.open();
  await Promise.resolve();
  f.$('#citationClose').onclick();
  pending.resolve({ doi: '10.1234/paper', title: 'late', version: 'test' });
  await opening;
  assert.equal(f.$('#citationContent').hidden, true);
});

test('latest export selection wins when responses arrive out of order', async () => {
  const pending = deferred();
  const f = fixture(undefined, { exported: async (_doi, format) => format === 'bibtex' ? pending.promise : 'RIS source' });
  await f.controller.open();
  const old = f.$('#export-bibtex').onclick();
  await f.$('#export-endnote').onclick();
  pending.resolve('late BibTeX');
  await old;
  assert.equal(f.$('#citationExportText').value, 'RIS source');
  f.$('#citationExportSave').onclick();
  assert.deepEqual(f.downloads, [{ text: 'RIS source', filename: 'citation.ris' }]);
});
