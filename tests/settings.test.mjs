import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dismissOnOutsideClick } from '../dialog.js';

const source = (await readFile(new URL('../settings.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/export /g, '');

function fixture(save = async () => {}) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', handlers: new Map(),
      getBoundingClientRect: () => ({ left: 100, right: 400, top: 100, bottom: 300 }),
      addEventListener(type, fn) { this.handlers.set(type, fn); },
      querySelector: $,
      showModal() { this.open = true; }, close() { this.open = false; this.onclose?.(); },
    });
    return elements.get(id);
  };
  const { openSettings } = vm.runInNewContext(`(function(){${source}; return { openSettings };})()`, {
    self: { chrome: { storage: { local: { set: save } } } },
    document: { querySelector: $ }, dismissOnOutsideClick, DEFAULT_MODEL: 'mock-model',
  });
  return { $, openSettings };
}

test('outside settings click cancels without saving credentials', async () => {
  let saves = 0;
  const f = fixture(async () => { saves++; });
  const result = f.openSettings({ geminiKey: 'mock-key', geminiModel: 'mock-model' });
  const dialog = f.$('#settings');
  const click = { target: dialog, button: 0, clientX: 50, clientY: 50 };
  dialog.handlers.get('pointerdown')(click);
  dialog.handlers.get('click')(click);
  assert.equal(await result, null);
  assert.equal(saves, 0);
});

test('native dialog close during asynchronous save does not replace the saved settings with cancellation', async () => {
  let finish;
  const saving = new Promise((resolve) => { finish = resolve; });
  const f = fixture(() => saving);
  const result = f.openSettings({ geminiKey: 'mock-key', geminiModel: 'mock-model' });
  f.$('#model').value = 'updated-model';
  const submit = f.$('form').onsubmit({ submitter: { value: 'save' } });
  f.$('#settings').close(); // method=dialog closes before storage finishes.
  finish();
  await submit;
  assert.equal((await result).geminiModel, 'updated-model');
});
