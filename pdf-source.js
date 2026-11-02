// Chrome MIME handlers supply a one-use stream; legacy viewer links supply a URL.
export function viewerFileUrl(search) {
  const match = /[?&]file=(.*)$/s.exec(search);
  if (!match) return null;
  return /^[a-z]+%3A/i.test(match[1]) ? decodeURIComponent(match[1]) : match[1];
}

// Scholar's own Chrome-viewer action uses #gsr=0 to opt out of its PDF overlay.
export function viewerDestinationUrl(url, destination) {
  if (!['normal', 'chrome'].includes(destination)) throw new Error('不明なビューアです');
  const target = new URL(url);
  if (!['https:', 'http:', 'file:'].includes(target.protocol)) throw new Error('PDFのURLが不正です');
  const hash = new URLSearchParams(target.hash.slice(1));
  hash.set('gsr', destination === 'chrome' ? '0' : '1');
  target.hash = hash.toString();
  return target.href;
}

const withoutHash = (url) => url?.split('#')[0];
const requestsOtherViewer = (url) => {
  try { return ['0', '1'].includes(new URLSearchParams(new URL(url).hash.slice(1)).get('gsr')); }
  catch { return false; }
};

export async function resolvePdfSource({ search, mimeHandler, storage, getFrameUrl, fetch: fetchPdf = globalThis.fetch }) {
  const originalUrl = viewerFileUrl(search);
  if (originalUrl || !mimeHandler?.getStreamInfo) {
    return { originalUrl, parameters: async () => ({ url: originalUrl }) };
  }
  let stream;
  try { stream = await mimeHandler.getStreamInfo(); }
  catch { return { originalUrl: null }; } // An ordinary viewer.html has no MIME stream.
  if (stream.embedded) throw new Error('埋め込みでは表示できません');
  if (!stream.originalUrl || !stream.streamUrl) throw new Error('PDFのストリーム情報を取得できませんでした');

  const bypassKey = `nativePdf:${stream.tabId}`;
  const bypass = storage ? (await storage.get({ [bypassKey]: null }))[bypassKey] : null;
  // Chrome may omit the navigation fragment from stream.originalUrl.
  const frameUrl = getFrameUrl ? await getFrameUrl(stream.tabId).catch(() => null) : null;
  const address = withoutHash(frameUrl) === withoutHash(stream.originalUrl) ? frameUrl : stream.originalUrl;
  const nativeFallback = !!bypass && withoutHash(bypass) === withoutHash(stream.originalUrl)
    || requestsOtherViewer(address);
  // The choice belongs to this tab and PDF, not just one navigation. Keep it
  // through refresh; release it when a different document reaches this tab.
  if (bypass && storage && withoutHash(bypass) !== withoutHash(stream.originalUrl)) await storage.remove(bypassKey);

  let bytes;
  const read = (onProgress = () => {}) => bytes ??= (async () => {
    const response = await fetchPdf(stream.streamUrl);
    if (!response.ok) throw new Error(`PDFの読み込みに失敗しました (${response.status})`);
    const header = Object.entries(stream.responseHeaders || {}).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
    const total = Number(response.headers.get('content-length') || header) || 0;
    if (!response.body) {
      const data = new Uint8Array(await response.arrayBuffer());
      onProgress({ loaded: data.length, total: total || data.length });
      return data;
    }
    const reader = response.body.getReader(), chunks = [];
    let loaded = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.length;
        onProgress({ loaded, total });
      }
    } finally { reader.releaseLock(); }
    const data = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return data;
  })();
  return {
    originalUrl: stream.originalUrl, tabId: stream.tabId, nativeFallback,
    parameters: async (onProgress) => ({ data: await read(onProgress), docBaseUrl: stream.originalUrl }),
    async fallback() {
      // Consume first so Chrome can reuse the buffer, including POST/single-use PDFs.
      await read().catch(() => {});
      await mimeHandler.abortAndFallbackToNativeHandler();
    },
  };
}
