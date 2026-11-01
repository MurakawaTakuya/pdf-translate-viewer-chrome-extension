import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const background = (await readFile(new URL('../background.js', import.meta.url), 'utf8')).replace(/^setUp\(\);$/m, '');
const popup = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const VIEWER = 'chrome-extension://test/viewer.html';

function fixture(mime = true) {
  const calls = [], local = { autoOpen: true }, session = {}, events = {};
  const listen = (name) => ({ addListener: (listener) => { events[name] = listener; } });
  const chrome = {
    runtime: { getURL: () => VIEWER, onStartup: listen('startup'), onInstalled: listen('installed'), onMessage: listen('message') },
    storage: {
      local: { get: async (defaults) => ({ ...defaults, ...local }) },
      session: { get: async (defaults) => ({ ...defaults, ...session }), set: async (next) => Object.assign(session, next), remove: async (key) => { delete session[key]; } },
      onChanged: listen('settings'),
    },
    declarativeNetRequest: {
      updateSessionRules: async (options) => calls.push(['sessionRules', options]),
      updateDynamicRules: async (options) => calls.push(['dynamicRules', options]),
    },
    action: {
      setBadgeText: async (options) => calls.push(['badge', options]),
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
    },
    tabs: { update: async (id, options) => calls.push(['navigate', id, options]) },
    webNavigation: { onBeforeNavigate: listen('before'), onCommitted: listen('committed') },
  };
  if (mime) chrome.mimeHandler = {
    getStreamInfo() { assert.fail('stream info belongs to the handler page, never the service worker'); },
    setMimeHandlerOptions: async (...args) => calls.push(['mimeOptions', ...args]),
  };
  const api = vm.runInNewContext(`(function(){${background};return {applyAutoOpen,openOriginal};})()`, { chrome, console });
  return { api, chrome, get calls() { return JSON.parse(JSON.stringify(calls)); }, local, session, events };
}

test('MIME routing removes persisted legacy redirects before enabling original-URL handling', async () => {
  const f = fixture(); await f.api.applyAutoOpen();
  assert.deepEqual(f.calls[0], ['sessionRules', { removeRuleIds: [1, 2, 3] }]);
  assert.deepEqual(f.calls[1], ['dynamicRules', { removeRuleIds: [1, 2, 3], addRules: [] }]);
  assert.deepEqual(f.calls[2], ['mimeOptions', 'application/pdf', { enabled: true }]);
  await f.events.before({ frameId: 0, tabId: 42, url: 'file:///paper.pdf' });
  assert.equal(f.calls.some(([kind]) => kind === 'navigate'), false);
});

test('auto-open OFF disables the MIME handler and preserves the existing OFF indicator', async () => {
  const f = fixture(); f.local.autoOpen = false;
  await f.api.applyAutoOpen();
  assert.deepEqual(f.calls[2], ['mimeOptions', 'application/pdf', { enabled: false }]);
  assert.deepEqual(f.calls[3], ['badge', { text: 'OFF' }]);
});

test('old Chrome retains both HTTP redirects and the local-file route', async () => {
  const f = fixture(false); await f.api.applyAutoOpen();
  const rules = f.calls.find(([kind]) => kind === 'dynamicRules')[1].addRules;
  assert.equal(rules.length, 3);
  assert.equal(rules[0].action.type, 'redirect');
  await f.events.before({ frameId: 0, tabId: 42, url: 'file:///paper.pdf' });
  assert.equal(f.calls.at(-1)[2].url, VIEWER + '?file=file%3A%2F%2F%2Fpaper.pdf');
});

test('an old viewer tab can bypass the MIME handler for exactly one tab and source', async () => {
  const f = fixture(), url = 'https://arxiv.org/pdf/2301.08243';
  await f.api.openOriginal(42, url);
  assert.equal(f.session['nativePdf:42'], url);
  assert.deepEqual(f.calls, [['navigate', 42, { url }]]);
  delete f.session['nativePdf:42'];
  f.local.autoOpen = false;
  await f.api.openOriginal(42, url);
  assert.equal(f.session['nativePdf:42'], undefined);
});

test('manual open explicitly selects this viewer even when another MIME handler has priority', async () => {
  const f = fixture(), url = 'https://arxiv.org/pdf/2301.08243';
  const send = () => new Promise((resolve) => f.events.message({ type: 'openInViewer', tabId: 42, url }, {}, resolve));
  assert.equal((await send()).ok, true);
  assert.equal(f.calls.at(-1)[2].url, VIEWER + '?file=' + encodeURIComponent(url));
  f.local.autoOpen = false;
  await send();
  assert.equal(f.calls.at(-1)[2].url, VIEWER + '?file=' + encodeURIComponent(url));
  assert.equal(f.local.autoOpen, false);
  assert.equal(f.calls.some(([kind]) => kind === 'mimeOptions'), false);
});

test('switching viewers reloads only same-document PDF navigation and leaves automatic routing enabled', async () => {
  const f = fixture(), url = 'https://arxiv.org/pdf/2301.08243';
  f.chrome.tabs.get = async () => ({ id: 42, url });
  f.chrome.tabs.reload = async (id) => f.chrome.tabs.update(id, { reload: true });
  await f.api.openOriginal(42, url + '#page=2&gsr=0');
  assert.deepEqual(f.calls, [['navigate', 42, { url: url + '#page=2&gsr=0' }], ['navigate', 42, { reload: true }]]);
  assert.equal(f.local.autoOpen, true);
  assert.equal(f.calls.some(([kind]) => kind === 'mimeOptions'), false);
});

test('a failed viewer navigation removes its one-shot bypass rather than affecting a later open', async () => {
  const f = fixture();
  f.chrome.tabs.update = async () => { throw new Error('closed tab'); };
  await assert.rejects(f.api.openOriginal(42, 'https://arxiv.org/pdf/2301.08243#gsr=1'), /closed tab/);
  assert.equal(f.session['nativePdf:42'], undefined);
});

async function popupFixture(viewerState) {
  const elements = new Map(), messages = [];
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { classList: { add() {} } });
    return elements.get(selector);
  };
  await vm.runInNewContext(`(async()=>{${popup}})()`, {
    URL, document: { querySelector: element }, window: { close() {} },
    chrome: {
      runtime: { getURL: () => VIEWER, sendMessage: () => assert.fail('native MIME handoff belongs to the current handler frame') },
      storage: { local: { get: async () => ({ autoOpen: true }) } },
      tabs: {
        query: async () => [{ id: 42, url: 'https://arxiv.org/pdf/2301.08243' }],
        sendMessage: async (_id, message) => { messages.push(message); return viewerState; },
      },
    },
  });
  return { element, messages };
}

test('popup recognizes a MIME viewer despite the address bar containing the original PDF URL', async () => {
  const f = await popupFixture({ fileUrl: 'https://arxiv.org/pdf/2301.08243', mime: true });
  assert.equal(f.element('#action').textContent, 'このPDFを通常のビューアで開く');
  await f.element('#action').onclick();
  assert.equal(f.messages.at(-1).type, 'openNativeViewer');
});

test('popup still offers a manual viewer open for a native PDF tab', async () => {
  const f = await popupFixture(null);
  assert.equal(f.element('#action').textContent, 'このPDFを翻訳ビューアで開く');
});

test('file PDF viewer selection uses the main-frame URL even when Tab.url is hidden', async () => {
  const f = fixture(), url = 'file:///papers/local.pdf';
  f.chrome.tabs.get = async () => ({ id: 42 });
  f.chrome.webNavigation.getFrame = async ({ frameId }) => { assert.equal(frameId, 0); return { url: url + '#page=2' }; };
  f.chrome.tabs.reload = async (id) => f.chrome.tabs.update(id, { reload: true });
  await f.api.openOriginal(42, url + '#page=2&gsr=0');
  assert.deepEqual(f.calls.at(-1), ['navigate', 42, { reload: true }]);
  assert.equal(f.session['nativePdf:42'], url + '#page=2&gsr=0');
});

test('a MIME menu handoff forces a reload even if the current address cannot be read', async () => {
  const f = fixture();
  f.chrome.tabs.get = async () => ({ id: 42 });
  f.chrome.webNavigation.getFrame = async () => null;
  f.chrome.tabs.reload = async (id) => f.chrome.tabs.update(id, { reload: true });
  await f.api.openOriginal(42, 'file:///papers/local.pdf#gsr=1', true);
  assert.deepEqual(f.calls.at(-1), ['navigate', 42, { reload: true }]);
});
