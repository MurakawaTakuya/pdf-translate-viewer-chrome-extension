// Chromeのズーム操作をPDFの倍率へ渡し、ブラウザによるヘッダーの拡大を止める。
export async function createNativeZoom(tabs, { getZoom, onZoom }) {
  if (!tabs?.getCurrent || !tabs.setZoomSettings || !tabs.setZoom || !tabs.getZoom || !tabs.onZoomChange) return null;
  const tab = await tabs.getCurrent();
  if (!Number.isInteger(tab?.id)) return null;
  await tabs.setZoomSettings(tab.id, { mode: 'manual', scope: 'per-tab' });
  let queued = null, expected = null, syncing = false;
  const near = (a, b) => Math.abs(a - b) < 1e-6;

  async function sync(zoom) {
    queued = expected = Math.min(5, Math.max(0.25, zoom));
    if (syncing) return;
    syncing = true;
    try {
      while (queued !== null) {
        const next = queued;
        queued = null;
        await tabs.setZoom(tab.id, next);
      }
    } finally { syncing = false; }
  }

  tabs.onZoomChange.addListener(async (event) => {
    if (event.tabId !== tab.id || syncing || near(event.newZoomFactor, expected) || near(event.newZoomFactor, getZoom())) return;
    try {
      // 遅れて到着した古いsetZoomのイベントで、最新の倍率を巻き戻さない。
      const actual = await tabs.getZoom(tab.id);
      if (!syncing && near(actual, event.newZoomFactor)) onZoom(actual);
    } catch { /* タブの終了などは無視する */ }
  });
  return { sync };
}
