// Chrome MIME handlers supply a one-use stream; legacy viewer links supply a URL.
export function viewerFileUrl(search) {
  const match = /[?&]file=(.*)$/s.exec(search);
  if (!match) return null;
  return /^[a-z]+%3A/i.test(match[1]) ? decodeURIComponent(match[1]) : match[1];
}

export async function resolvePdfSource({ search, mimeHandler, storage, fetch: fetchPdf = globalThis.fetch }) {
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
  const nativeFallback = bypass === stream.originalUrl;
  if (bypass && storage) await storage.remove(bypassKey);

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
