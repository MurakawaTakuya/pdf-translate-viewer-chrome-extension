const VIEWER = chrome.runtime.getURL('viewer.html');
const toViewer = (url) => `${VIEWER}?file=${encodeURIComponent(url)}`;
const mimeHandler = chrome.mimeHandler?.getStreamInfo ? chrome.mimeHandler : null;

// Web上のPDF（http/https）は、読み込みの段階で行き先をビューアに差し替える。
// ページを開いてから移動し直す方式だと、PDFのページが履歴に残って「戻る」でループしてしまうため。
const PDF_URL_PATTERNS = [
  String.raw`^https?://[^?#]*\.pdf(\?.*)?$`, // 末尾が .pdf
  String.raw`^https?://([^/?#]+\.)?arxiv\.org/pdf/.*$`,
  String.raw`^https?://([^/?#]+\.)?openreview\.net/pdf.*$`,
];
const BYPASS_RULE_ID = 1000; // 「通常のビューアで開く」ときに、そのPDFだけ差し替えを止める規則

// ---------- 自動切り替えの ON / OFF ----------
const isAutoOpen = async () => (await chrome.storage.local.get({ autoOpen: true })).autoOpen;

// 連続で呼ばれても重ならないよう、1回ずつ順番に実行する（同時に走ると「同じIDの規則がある」で失敗する）
let applying = Promise.resolve();
function applyAutoOpen() {
  applying = applying.then(applyAutoOpenNow, applyAutoOpenNow);
  return applying;
}

async function applyAutoOpenNow() {
  const auto = await isAutoOpen();
  const rules = !auto || mimeHandler ? [] : PDF_URL_PATTERNS.map((regexFilter, i) => ({
    id: i + 1,
    priority: 1,
    // \0 = 一致したURL全体。ビューアは file= 以降をそのままPDFのURLとして読む
    action: { type: 'redirect', redirect: { regexSubstitution: `${VIEWER}?file=\\0` } },
    condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] },
  }));
  // 規則はディスクに保存する（Chromeを再起動しても消えない）。保存に失敗する環境では、
  // ブラウザを閉じると消える「セッションの規則」で代わりにする。自分が使うIDは毎回消してから入れ直す
  const ids = PDF_URL_PATTERNS.map((_, i) => i + 1);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: rules });
  } catch (e) {
    console.warn('規則を保存できなかったので、セッションの規則で代わりにします', e);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids }).catch(() => {});
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  }
  // Remove persisted redirects before enabling Chrome's original-URL handler.
  if (mimeHandler) await mimeHandler.setMimeHandlerOptions('application/pdf', { enabled: auto });
  // OFF のときはアイコンに「OFF」と出す
  await chrome.action.setBadgeText({ text: auto ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  await chrome.action.setTitle({ title: `PDF翻訳ビューア（自動で開く: ${auto ? 'ON' : 'OFF'}）` });
}
const setUp = () => applyAutoOpen().catch((e) => console.error('PDFの自動切り替えを設定できませんでした', e));
setUp();
// Chromeの起動時・拡張の更新時にも、拡張を起こして登録し直す
chrome.runtime.onStartup.addListener(setUp);
chrome.runtime.onInstalled.addListener(setUp);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoOpen' in changes) applyAutoOpen();
});

// PC内のPDF（file://）は上の仕組みが使えないので、開こうとした時点でビューアに切り替える
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (mimeHandler) return; // Chrome supplies file:// streams as well.
    if (details.frameId !== 0 || !(await isAutoOpen())) return;
    const { bypass } = await chrome.storage.session.get({ bypass: '' });
    if (bypass === details.url) { await chrome.storage.session.remove('bypass'); return; }
    chrome.tabs.update(details.tabId, { url: toViewer(details.url) });
  },
  { url: [{ schemes: ['file'], pathSuffix: '.pdf' }] }
);

// ---------- ポップアップ・ビューアからの依頼 ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'openInViewer') {
    // Explicitly select this viewer. Reloading the original URL could instead
    // reopen another extension that has higher MIME-handler priority.
    // Normal PDF navigation still uses the original-URL MIME route.
    chrome.storage.session.remove(`nativePdf:${msg.tabId}`).then(() => chrome.tabs.update(msg.tabId, { url: toViewer(msg.url) }))
      .then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'openOriginal') {
    openOriginal(msg.tabId, msg.url, msg.reload === true, msg.handoff === true).then((result) => reply({ ok: true, ...result }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
});

// 翻訳ビューアを通さずに、このPDFだけ通常のビューアで開く（自動切り替えが ON のままでも）
async function openOriginal(tabId, url, reload = false, handoff = false) {
  if (mimeHandler) {
    // Old viewer.html tabs can also hand just this navigation to the native viewer.
    // webNavigation already has permission to read file URLs; Tab.url can be
    // hidden when file-host access is off, even though MIME handling still works.
    const frame = chrome.webNavigation.getFrame
      ? await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null) : null;
    const currentUrl = frame?.url || (chrome.tabs.get ? (await chrome.tabs.get(tabId)).url : null);
    const samePdf = currentUrl?.split('#')[0] === url.split('#')[0];
    // A handler can give its existing buffered PDF to Chrome after receiving
    // this reply. Never hand a different document that buffer, or unload the
    // frame with reload before it has acknowledged the prepared destination.
    if (handoff && !samePdf) throw new Error('同じPDFの表示先を確認できませんでした');
    const key = `nativePdf:${tabId}`;
    if (await isAutoOpen()) await chrome.storage.session.set({ [key]: url });
    try {
      await chrome.tabs.update(tabId, { url });
      if (!handoff && (reload || samePdf)) await chrome.tabs.reload(tabId);
    } catch (error) {
      await chrome.storage.session.remove(key);
      throw error;
    }
    return { handoff };
  }
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [BYPASS_RULE_ID],
    addRules: [{
      id: BYPASS_RULE_ID,
      priority: 2, // 差し替えの規則より優先
      action: { type: 'allow' },
      condition: { regexFilter: `^${escaped}$`, resourceTypes: ['main_frame'] },
    }],
  });
  await chrome.storage.session.set({ bypassTab: tabId, ...(url.startsWith('file:') ? { bypass: url } : {}) });
  await chrome.tabs.update(tabId, { url });
}

// 通常のビューアで開き終わったら、止めていた差し替えを元に戻す
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (mimeHandler) {
    const key = `nativePdf:${details.tabId}`;
    const selected = (await chrome.storage.session.get({ [key]: null }))[key];
    if (selected && selected.split('#')[0] !== details.url.split('#')[0]) await chrome.storage.session.remove(key);
    return;
  }
  if (details.url.startsWith(VIEWER)) return;
  const { bypassTab } = await chrome.storage.session.get({ bypassTab: null });
  if (bypassTab !== details.tabId) return;
  await chrome.storage.session.remove('bypassTab');
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [BYPASS_RULE_ID] });
});

chrome.tabs.onRemoved?.addListener((tabId) => chrome.storage.session.remove(`nativePdf:${tabId}`));
