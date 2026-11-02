import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePdfSource, viewerFileUrl, viewerDestinationUrl } from '../pdf-source.js';

const originalUrl = 'https://arxiv.org/pdf/2301.08243';
function fixture(extra = {}) {
  const calls = [], removed = [];
  const info = { originalUrl, streamUrl: 'stream://once', tabId: 42, embedded: false,
    responseHeaders: { 'Content-Length': '5' } };
  const options = { search: '',
    mimeHandler: { getStreamInfo: async () => info, abortAndFallbackToNativeHandler: async () => calls.push('native') },
    storage: { get: async () => ({}), remove: async (key) => removed.push(key) },
    fetch: async (url) => {
      calls.push(url);
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3, 4, 5])); c.close(); } }));
    }, ...extra };
  return { options, calls, info, removed };
}

test('legacy viewer URLs keep literal query separators, plus signs and fragments', async () => {
  const url = 'https://example.org/test.pdf?a=1&b=x+y#page=2';
  assert.equal(viewerFileUrl('?file=' + url), url);
  assert.equal(viewerFileUrl('?file=' + encodeURIComponent(url)), url);
  const f = fixture({ search: '?file=' + encodeURIComponent(url) });
  f.options.mimeHandler.getStreamInfo = () => assert.fail('explicit viewer link has no MIME stream');
  const source = await resolvePdfSource(f.options);
  assert.equal(source.originalUrl, url);
  assert.deepEqual(await source.parameters(), { url });
  assert.deepEqual(f.calls, []);
});

test('MIME source consumes the received stream once, reports byte progress, and retains original citation URL', async () => {
  const f = fixture(), progress = [], source = await resolvePdfSource(f.options);
  const [a, b] = await Promise.all([source.parameters((p) => progress.push(p)), source.parameters()]);
  assert.equal(source.originalUrl, originalUrl);
  assert.equal(a.docBaseUrl, originalUrl);
  assert.equal(a.url, undefined);
  assert.deepEqual([...a.data], [1, 2, 3, 4, 5]);
  assert.equal(a.data, b.data);
  assert.deepEqual(progress, [{ loaded: 2, total: 5 }, { loaded: 5, total: 5 }]);
  await source.fallback();
  assert.deepEqual(f.calls, ['stream://once', 'native']);
});

test('native handoff buffers the one-use PDF before aborting even without prior rendering', async () => {
  const f = fixture(), source = await resolvePdfSource(f.options);
  await source.fallback();
  assert.deepEqual(f.calls, ['stream://once', 'native']);
});

test('a failed stream is never fetched twice and native handoff remains available', async () => {
  let requests = 0;
  const f = fixture({ fetch: async () => { requests++; throw new Error('offline'); } });
  const source = await resolvePdfSource(f.options);
  await assert.rejects(source.parameters(), /offline/);
  await assert.rejects(source.parameters(), /offline/);
  await source.fallback();
  assert.equal(requests, 1);
  assert.deepEqual(f.calls, ['native']);
});

test('the viewer choice survives refresh for the same source and is removed for a different PDF', async () => {
  for (const url of [originalUrl, 'https://example.org/other.pdf']) {
    const f = fixture({ storage: { get: async () => ({ 'nativePdf:42': url }), remove: async (key) => f.removed.push(key) } });
    const source = await resolvePdfSource(f.options);
    assert.equal(source.nativeFallback, url === originalUrl);
    assert.deepEqual(f.removed, url === originalUrl ? [] : ['nativePdf:42']);
    assert.deepEqual(f.calls, []);
  }
  const otherTab = fixture({ storage: { get: async () => ({ 'nativePdf:42': originalUrl }), remove: async () => assert.fail('another tab choice must stay untouched') } });
  otherTab.info.tabId = 43;
  assert.equal((await resolvePdfSource(otherTab.options)).nativeFallback, false);
});

test('an embedded PDF is refused and an ordinary page cannot manufacture a MIME context', async () => {
  const f = fixture(); f.info.embedded = true;
  await assert.rejects(resolvePdfSource(f.options), /埋め込み/);
  f.options.mimeHandler.getStreamInfo = async () => { throw new Error('no associated stream'); };
  assert.equal((await resolvePdfSource(f.options)).originalUrl, null);
  assert.deepEqual(f.calls, []);
});

test('an absent content length keeps progress indeterminate rather than inventing a percentage', async () => {
  const f = fixture(); f.info.responseHeaders = {};
  const source = await resolvePdfSource(f.options), progress = [];
  await source.parameters((p) => progress.push(p));
  assert.deepEqual(progress, [{ loaded: 2, total: 0 }, { loaded: 5, total: 0 }]);
});

test('viewer destinations preserve the paper URL, query and page anchor while opting Scholar in or out', () => {
  const url = 'https://arxiv.org/pdf/2301.08243?download=1#page=3&zoom=150&gsr=0';
  const normal = new URL(viewerDestinationUrl(url, 'normal'));
  const native = new URL(viewerDestinationUrl(normal.href, 'chrome'));
  assert.equal(normal.origin + normal.pathname + normal.search, url.split('#')[0]);
  assert.equal(new URLSearchParams(normal.hash.slice(1)).get('gsr'), '1');
  assert.equal(new URLSearchParams(native.hash.slice(1)).get('gsr'), '0');
  assert.equal(new URLSearchParams(native.hash.slice(1)).get('page'), '3');
  assert.throws(() => viewerDestinationUrl('javascript:alert(1)', 'chrome'));
});

test('both normal and Chrome viewer choices are honored when Chrome strips the stream hash', async () => {
  const f = fixture({ getFrameUrl: async () => originalUrl + '#page=3&gsr=0' });
  const source = await resolvePdfSource(f.options);
  assert.equal(source.nativeFallback, true);
  assert.equal(source.originalUrl, originalUrl);
  await source.fallback();
  assert.deepEqual(f.calls, ['stream://once', 'native']);
  for (const url of [originalUrl + '#page=3&gsr=1', originalUrl + '#page=3&gsr=0']) {
    assert.equal((await resolvePdfSource(fixture({ getFrameUrl: async () => url }).options)).nativeFallback, true);
  }
  for (const url of [originalUrl, originalUrl + '#gsr=2', 'https://example.org/other.pdf#gsr=0']) {
    assert.equal((await resolvePdfSource(fixture({ getFrameUrl: async () => url }).options)).nativeFallback, false);
  }
});

test('a stored normal viewer choice ignores fragments and survives repeated refreshes without a stream hash', async () => {
  const f = fixture({ storage: { get: async () => ({ 'nativePdf:42': originalUrl + '#gsr=1' }), remove: async () => assert.fail('refresh must not consume the choice') } });
  assert.equal((await resolvePdfSource(f.options)).nativeFallback, true);
  assert.equal((await resolvePdfSource(f.options)).nativeFallback, true);
});

test('removing gsr=0 from the address does not erase a Chrome choice, but an explicit viewer link overrides it', async () => {
  const options = { storage: { get: async () => ({ 'nativePdf:42': originalUrl + '#gsr=0' }), remove: async () => assert.fail('the same PDF choice must persist') }, getFrameUrl: async () => originalUrl };
  assert.equal((await resolvePdfSource(fixture(options).options)).nativeFallback, true);
  const explicit = await resolvePdfSource(fixture({ ...options, search: '?file=' + encodeURIComponent(originalUrl + '#gsr=0') }).options);
  assert.equal(explicit.nativeFallback, undefined);
  assert.deepEqual(await explicit.parameters(), { url: originalUrl + '#gsr=0' });
});
