import test from 'node:test';
import assert from 'node:assert/strict';
import { citationIdentifier, detectCitationIdentifier, parseArxivMetadata, matchingPublication, createCitationService } from '../citations.js';

const doi = '10.1234/paper';
const title = 'Self-supervised learning from images';
const metadata = { DOI: doi, title, editor: [{ given: '', family: '' }] };
const html = `<meta name="citation_title" content="${title}"><meta content="Jane Smith" name="citation_author"><meta name='citation_date' content='2023/01/01'>`;
const candidate = { DOI: doi, type: 'proceedings-article', title: [title], author: [{ family: 'Smith' }], published: { 'date-parts': [[2023]] } };

test('identifiers handle PDF URLs, versions, old arXiv IDs and DOI punctuation', () => {
  assert.deepEqual(citationIdentifier('https://arxiv.org/pdf/2301.08243v2.pdf?download=1'), { type: 'arxiv', value: '2301.08243' });
  assert.deepEqual(citationIdentifier('arXiv: hep-th/9901001v3'), { type: 'arxiv', value: 'hep-th/9901001' });
  assert.deepEqual(citationIdentifier('(https://doi.org/10.1234/paper).'), { type: 'doi', value: doi });
  assert.deepEqual(citationIdentifier('https://publisher.example/doi/pdf/10.1234/paper.pdf'), { type: 'doi', value: doi });
  assert.equal(citationIdentifier('unidentified.pdf'), null);
});

test('PDF detection prefers URL and metadata, otherwise explicit first-page identifiers', async () => {
  assert.equal((await detectCitationIdentifier('https://arxiv.org/pdf/2301.08243', null)).value, '2301.08243');
  assert.equal((await detectCitationIdentifier('file:///paper.pdf', { getMetadata: async () => ({ info: { DOI: doi } }) })).value, doi);
  const pdf = (str) => ({ getMetadata: async () => ({}), getPage: async () => ({ getTextContent: async () => ({ items: [{ str }] }) }) });
  assert.equal((await detectCitationIdentifier('', pdf('DOI: 10.1234/paper'))).value, doi);
  assert.equal(await detectCitationIdentifier('', pdf('random number 10.1234/paper')), null);
});

test('arXiv metadata decoding and strict publication matching avoid ambiguous citations', () => {
  assert.equal(parseArxivMetadata('<meta content="A &amp; B &#x2014; &quot;Test&quot;" name="citation_title">').title, 'A & B — "Test"');
  const arxiv = parseArxivMetadata(html);
  assert.equal(matchingPublication([candidate], arxiv), candidate);
  assert.equal(matchingPublication([candidate], { ...arxiv, authors: ['Smith, Jane'] }), candidate);
  assert.equal(matchingPublication([candidate, { ...candidate, DOI: '10.1234/other' }], arxiv), null);
  assert.equal(matchingPublication([{ ...candidate, author: [{ family: 'Jones' }] }], arxiv), null);
  assert.equal(matchingPublication([{ ...candidate, title: [title + ' revised'] }], arxiv), null);
});

test('arXiv resolves unique published match, caches formats and sends only public metadata', async () => {
  const calls = [];
  const service = createCitationService({ fetch: async (url, options) => {
    calls.push({ url, options });
    let body;
    const accept = options.headers.Accept;
    if (url.startsWith('https://arxiv.org/abs/')) body = html;
    else if (url.startsWith('https://api.crossref.org/works?')) body = JSON.stringify({ message: { items: [candidate] } });
    else if (accept.includes('csl+json')) body = JSON.stringify(metadata);
    else if (accept.includes('text/x-bibliography')) body = 'Smith, Jane. Paper, edited by , Publisher.';
    else body = 'TY  - CONF\nER  -';
    return new Response(body);
  } });
  const record = await service.resolve('2301.08243');
  assert.equal(record.doi, doi);
  assert.equal(record.version, '出版版（Crossref）');
  assert.equal(await service.resolve('2301.08243'), record);
  assert.equal(await service.formatted(doi, 'mla'), 'Smith, Jane. Paper, Publisher.');
  assert.equal(await service.formatted(doi, 'mla'), 'Smith, Jane. Paper, Publisher.');
  assert.equal(await service.exported(doi, 'ris'), 'TY  - CONF\nER  -');
  assert.equal(calls.length, 5);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.body, undefined);
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
  }
});

test('unavailable publication lookup falls back to the identified arXiv record', async () => {
  const preprint = '10.48550/arXiv.2301.08243';
  const service = createCitationService({ fetch: async (url) => {
    if (url.startsWith('https://arxiv.org/')) throw new Error('offline');
    assert.equal(url.toLowerCase(), `https://doi.org/${preprint}`.toLowerCase());
    return new Response(JSON.stringify({ DOI: preprint.toLowerCase(), title }));
  } });
  const result = await service.resolve('2301.08243');
  assert.equal(result.doi, preprint);
  assert.equal(result.version, 'arXiv版');
});

test('metadata mismatch and invalid input fail; failed requests may be retried explicitly', async () => {
  let calls = 0;
  const service = createCitationService({ fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ ...metadata, DOI: calls === 1 ? '10.1234/other' : doi }));
  } });
  await assert.rejects(service.resolve({ type: 'arxiv', value: doi }), /入力/);
  assert.equal(calls, 0);
  await assert.rejects(service.resolve(doi), /確認/);
  assert.equal((await service.resolve(doi)).doi, doi);
  assert.equal(calls, 2);
});

test('real named editors are retained; failed format fetch is not cached', async () => {
  let failures = 0;
  const service = createCitationService({ fetch: async (_url, options) => {
    if (options.headers.Accept.includes('csl+json')) return new Response(JSON.stringify({ ...metadata, editor: [{ family: 'Jones' }] }));
    if (!failures++) return new Response('busy', { status: 503 });
    return new Response('Paper, edited by Jones, Publisher.');
  } });
  await service.resolve(doi);
  await assert.rejects(service.formatted(doi, 'mla'), /503/);
  assert.equal(await service.formatted(doi, 'mla'), 'Paper, edited by Jones, Publisher.');
});

test('HTML citation responses become copyable text without the known abstract', async () => {
  const abstract = 'An abstract is explanatory content and should not be part of the bibliographic citation.';
  const service = createCitationService({ fetch: async (_url, options) => new Response(options.headers.Accept.includes('csl+json')
    ? JSON.stringify({ ...metadata, abstract })
    : `<div class="csl-block">Smith &amp; Jones. <i>Paper</i>.</div><div class="csl-block">${abstract}</div>`) });
  await service.resolve(doi);
  assert.equal(await service.formatted(doi, 'iso'), 'Smith & Jones. Paper.');
});
