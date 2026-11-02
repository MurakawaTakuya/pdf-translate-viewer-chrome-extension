// Chrome自身の倍率は固定し、PDFの倍率だけをビューアで管理する。
// setZoomでPDF倍率を同期するとChromeのズームポップオーバーも出るため、同期しない。
export async function disableNativeZoom(tabs, tabId) {
  if (!tabs?.setZoomSettings) return false;
  const tab = Number.isInteger(tabId) ? { id: tabId } : await tabs.getCurrent?.();
  if (!Number.isInteger(tab?.id)) return false;
  await tabs.setZoomSettings(tab.id, { mode: 'disabled', scope: 'per-tab' });
  return true;
}
