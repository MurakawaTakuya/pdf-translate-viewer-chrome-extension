import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const background = (await readFile(new URL('../background.js', import.meta.url), 'utf8')).replace(/^setUp\(\);$/m, '');
const popup = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const VIEWER = 'chrome-extension://test/viewer.html';

function fixture(mime = true, timers = { setTimeout, clearTimeout }) {
  const calls = [], errors = [], local = { autoOpen: true }, session = {}, events = {};
  const listen = (name) => {
    const listeners = new Set();
    events[name] = (...args) => Promise.all([...listeners].map(listener => listener(...args)));
    return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), hasListener: listener => listeners.has(listener), get size() { return listeners.size; } };
  };
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
    tabs: { update: async (id, options) => {
      calls.push(['navigate', id, options]);
      if (options.url) await events.fragment({ tabId: id, frameId: 0, url: options.url });
    }, onRemoved: listen('removed') },
    webNavigation: { onBeforeNavigate: listen('before'), onCommitted: listen('committed'), onReferenceFragmentUpdated: listen('fragment'), onErrorOccurred: listen('navigationError') },
  };
  if (mime) chrome.mimeHandler = {
    getStreamInfo() { assert.fail('stream info belongs to the handler page, never the service worker'); },
    setMimeHandlerOptions: async (...args) => calls.push(['mimeOptions', ...args]),
  };
  const api = vm.runInNewContext(`(function(){${background};return {applyAutoOpen,openOriginal};})()`, { chrome, ...timers, console: { ...console, error: (...args) => errors.push(args) } });
  return { api, chrome, errors, get calls() { return JSON.parse(JSON.stringify(calls)); }, local, session, events };
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

test('a viewer choice is stored for just its tab and source', async () => {
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
  f.session['nativePdf:42'] = url;
  const send = () => new Promise((resolve) => f.events.message({ type: 'openInViewer', tabId: 42, url }, {}, resolve));
  assert.equal((await send()).ok, true);
  assert.equal(f.session['nativePdf:42'], undefined);
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

test('a fragment switch never reloads the old address even after tabs.update has resolved', async () => {
  const f = fixture(), base = 'https://arxiv.org/pdf/2301.08243', target = base + '#gsr=0';
  let updated, reloads = 0;
  const requested = new Promise(resolve => { updated = resolve; });
  f.chrome.webNavigation.getFrame = async () => ({ url: base });
  f.chrome.tabs.update = async () => { updated(); };
  f.chrome.tabs.reload = async () => { reloads++; };
  const pending = f.api.openOriginal(42, target, true);
  await requested;await Promise.resolve();
  assert.equal(reloads, 0);
  await f.events.fragment({ tabId: 43, frameId: 0, url: target });
  await f.events.fragment({ tabId: 42, frameId: 1, url: target });
  assert.equal(reloads, 0);
  await f.events.fragment({ tabId: 42, frameId: 0, url: target });
  await pending;
  assert.equal(reloads, 1);
  assert.equal(f.chrome.webNavigation.onReferenceFragmentUpdated.size, 0);
  assert.equal(f.chrome.webNavigation.onCommitted.size, 1);
  await f.events.fragment({ tabId: 42, frameId: 0, url: target });
  assert.equal(reloads, 1);
});

test('an already selected hash reloads directly, and a different PDF only navigates once', async () => {
  const target = 'https://arxiv.org/pdf/2301.08243#gsr=0', same = fixture();
  let reloads = 0;
  same.chrome.webNavigation.getFrame = async () => ({ url: target });
  same.chrome.tabs.update = async () => assert.fail('the current URL is already exact');
  same.chrome.tabs.reload = async () => { reloads++; };
  await same.api.openOriginal(42, target, true);
  assert.equal(reloads, 1);
  const other = fixture();
  other.chrome.webNavigation.getFrame = async () => ({ url: 'https://example.org/other.pdf' });
  other.chrome.tabs.reload = async () => assert.fail('a full navigation already creates a new document');
  await other.api.openOriginal(42, target, true);
  assert.deepEqual(other.calls, [['navigate', 42, { url: target }]]);
});

test('a same-PDF update that commits a new document does not reload it a second time', async () => {
  const f = fixture(), base = 'https://arxiv.org/pdf/2301.08243', target = base + '#gsr=0';
  f.chrome.webNavigation.getFrame = async () => ({ url: base });
  f.chrome.tabs.update = async () => f.events.committed({ tabId: 42, frameId: 0, url: target });
  f.chrome.tabs.reload = async () => assert.fail('the new document already started with gsr=0');
  await f.api.openOriginal(42, target, true);
  assert.equal(f.chrome.webNavigation.onReferenceFragmentUpdated.size, 0);
});

test('an unconfirmed fragment times out without reloading and removes temporary listeners', async () => {
  let timeout, updated;
  const requested = new Promise(resolve => { updated = resolve; });
  const f = fixture(true, { setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {} });
  const base = 'https://arxiv.org/pdf/2301.08243';
  f.chrome.webNavigation.getFrame = async () => ({ url: base });
  f.chrome.tabs.update = async () => { updated(); };
  f.chrome.tabs.reload = async () => assert.fail('an unconfirmed URL must never be reloaded');
  const pending = f.api.openOriginal(42, base + '#gsr=0', true);
  await requested;
  timeout();
  await assert.rejects(pending, /URL変更を確認/);
  assert.equal(f.session['nativePdf:42'], undefined);
  assert.equal(f.chrome.webNavigation.onReferenceFragmentUpdated.size, 0);
  assert.equal(f.chrome.webNavigation.onCommitted.size, 1);
  assert.equal(f.chrome.tabs.onRemoved.size, 1);
});

test('a failed viewer navigation removes its stored choice rather than affecting a later open', async () => {
  const f = fixture();
  f.chrome.tabs.update = async () => { throw new Error('closed tab'); };
  await assert.rejects(f.api.openOriginal(42, 'https://arxiv.org/pdf/2301.08243#gsr=1'), /closed tab/);
  assert.equal(f.session['nativePdf:42'], undefined);
});

test('same-PDF handoff replies after updating the hash without reloading its handler frame', async () => {
  const f = fixture(), base = 'https://arxiv.org/pdf/2301.08243', url = base + '#gsr=1';
  f.chrome.webNavigation.getFrame = async () => ({ url: base });
  f.chrome.tabs.reload = async () => assert.fail('the current MIME frame must perform its buffered fallback after the reply');
  const reply = await new Promise(resolve => f.events.message({ type: 'openOriginal', tabId: 42, url, reload: true, handoff: true }, {}, resolve));
  assert.equal(reply.ok, true);
  assert.equal(reply.handoff, true);
  assert.equal(f.session['nativePdf:42'], url);
  assert.deepEqual(f.calls, [['navigate', 42, { url }]]);
});

test('Chrome default selection is accepted before replacing the sender and then reloads the gsr=0 document', async () => {
  const f = fixture(), base = 'https://arxiv.org/pdf/2301.08243', url = base + '#gsr=0';
  let reply, reloaded;
  const reload = new Promise(resolve => { reloaded = resolve; });
  f.chrome.webNavigation.getFrame = async () => ({ url: base });
  f.chrome.tabs.update = async (tabId, change) => {
    assert.equal(reply.ok, true);
    assert.equal(reply.accepted, true);
    assert.equal(f.session['nativePdf:42'], url);
    assert.equal(change.url, url);
    await f.events.fragment({ tabId, frameId: 0, url });
  };
  f.chrome.tabs.reload = async tabId => { assert.equal(tabId, 42); reloaded(); };
  f.events.message({ type: 'openOriginal', tabId: 42, url, reload: true, handoff: false }, {}, result => { reply = result; });
  await reload;
  assert.equal(reply.handoff, false);
  assert.equal(f.errors.length, 0);
});

test('a reload failure after acceptance is logged and reported to a surviving viewer', async () => {
  const f = fixture(), url = 'https://arxiv.org/pdf/2301.08243#gsr=0';
  let reply, notified;
  const notification = new Promise(resolve => { notified = resolve; });
  f.chrome.tabs.reload = async () => { throw new Error('reload denied'); };
  f.chrome.tabs.sendMessage = async (tabId, message) => {
    assert.equal(tabId, 42);
    assert.equal(message.type, 'viewerSwitchFailed');
    assert.equal(message.error, 'reload denied');
    notified();
  };
  f.events.message({ type: 'openOriginal', tabId: 42, url, reload: true, handoff: false }, {}, result => { reply = result; });
  await notification;
  assert.equal(reply.accepted, true);
  assert.equal(f.errors[0][1].message, 'reload denied');
  assert.equal(f.session['nativePdf:42'], undefined);
});

test('a buffered handoff refuses a different or unconfirmed PDF before changing navigation', async () => {
  for (const currentUrl of ['https://example.org/other.pdf', undefined]) {
    const f = fixture();
    f.chrome.webNavigation.getFrame = async () => currentUrl ? { url: currentUrl } : null;
    const reply = await new Promise(resolve => f.events.message({ type: 'openOriginal', tabId: 42, url: 'https://arxiv.org/pdf/2301.08243#gsr=1', handoff: true }, {}, resolve));
    assert.equal(reply.ok, false);
    assert.match(reply.error, /同じPDF/);
    assert.equal(f.session['nativePdf:42'], undefined);
    assert.deepEqual(f.calls, []);
  }
});

test('refresh keeps the chosen viewer while a different PDF or tab removal releases that tab choice', async () => {
  const f = fixture(), base = 'https://arxiv.org/pdf/2301.08243';
  f.session['nativePdf:42'] = base + '#gsr=1';
  await f.events.committed({ frameId: 0, tabId: 42, url: base + '#page=3' });
  assert.equal(f.session['nativePdf:42'], base + '#gsr=1');
  await f.events.committed({ frameId: 0, tabId: 43, url: 'https://example.org/other.pdf' });
  assert.equal(f.session['nativePdf:42'], base + '#gsr=1');
  await f.events.committed({ frameId: 0, tabId: 42, url: base + '?different=1' });
  assert.equal(f.session['nativePdf:42'], undefined);
  f.session['nativePdf:42'] = base;
  await f.events.removed(42);
  assert.equal(f.session['nativePdf:42'], undefined);
});

async function popupFixture(viewerState, tabUrl = 'https://arxiv.org/pdf/2301.08243') {
  const elements = new Map(), messages = [], runtimeMessages = [];
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { classList: { add() {} } });
    return elements.get(selector);
  };
  await vm.runInNewContext(`(async()=>{${popup}})()`, {
    URL, document: { querySelector: element }, window: { close() {} },
    chrome: {
      runtime: { getURL: () => VIEWER, sendMessage: async message => { runtimeMessages.push(message); return { ok: true }; } },
      storage: { local: { get: async () => ({ autoOpen: true }) } },
      tabs: {
        query: async () => [{ id: 42, url: tabUrl }],
        sendMessage: async (_id, message) => { messages.push(message); return viewerState; },
      },
    },
  });
  return { element, messages, runtimeMessages };
}

test('popup recognizes a MIME viewer despite the address bar containing the original PDF URL', async () => {
  const f = await popupFixture({ fileUrl: 'https://arxiv.org/pdf/2301.08243', mime: true });
  assert.equal(f.element('#action').textContent, 'このPDFをChrome内蔵ビューアで開く');
  await f.element('#action').onclick();
  assert.equal(f.messages.at(-1).type, 'openChromeViewer');
});

test('popup still offers a manual viewer open for a native PDF tab', async () => {
  const f = await popupFixture(null);
  assert.equal(f.element('#action').textContent, 'このPDFを翻訳ビューアで開く');
});

test('the popup explicitly returns a Chrome PDF to this viewer and clears its stored viewer choice', async () => {
  const url = 'https://arxiv.org/pdf/2301.08243#gsr=0';
  const popup = await popupFixture(null, url);
  assert.equal(popup.element('#action').textContent, 'このPDFを翻訳ビューアで開く');
  await popup.element('#action').onclick();
  const message = popup.runtimeMessages.at(-1);
  assert.equal(message.type, 'openInViewer');
  assert.equal(message.url, url);
  const background = fixture();
  background.session['nativePdf:42'] = url;
  const result = await new Promise(resolve => background.events.message(message, {}, resolve));
  assert.equal(result.ok, true);
  assert.equal(background.session['nativePdf:42'], undefined);
  assert.equal(background.calls.at(-1)[2].url, VIEWER + '?file=' + encodeURIComponent(url));
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

test('legacy native switch bypasses the fragment-free request only in the selected tab',async()=>{
 const f=fixture(false),base='https://arxiv.org/pdf/2609.34178?download=1';
 await f.api.openOriginal(42,base+'#gsr=0',true);
 const rule=f.calls.find(([kind,options])=>kind==='sessionRules'&&options.addRules?.some(r=>r.id===1000))[1].addRules[0];
 assert.equal(new RegExp(rule.condition.regexFilter).test(base),true);
 assert.equal(new RegExp(rule.condition.regexFilter).test(base+'x'),false);
 assert.deepEqual(rule.condition.tabIds,[42]);
 assert.equal(f.calls.at(-1)[2].url,base+'#gsr=0');
 await f.events.committed({tabId:42,frameId:0,url:base+'#gsr=0'});
 assert.deepEqual(f.calls.at(-1),['sessionRules',{removeRuleIds:[1000]}]);
});
