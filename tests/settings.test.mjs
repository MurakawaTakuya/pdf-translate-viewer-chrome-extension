import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dismissOnOutsideClick } from '../dialog.js';

const source = (await readFile(new URL('../settings.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/export /g, '');

function fixture(save = async () => {}, saved = {}, extra = {}) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', handlers: new Map(), options: [{value:'gemini-3.5-flash-lite'},{value:'gemini-3.8-flash'},{value:'custom'}],
      getBoundingClientRect: () => ({ left: 100, right: 400, top: 100, bottom: 300 }),
      addEventListener(type, fn) { this.handlers.set(type, fn); },
      querySelector: $,
      showModal() { this.open = true; }, close() { this.open = false; this.onclose?.(); },
    });
    return elements.get(id);
  };
  const { openSettings, loadSettings } = vm.runInNewContext(`(function(){${source}; return { openSettings, loadSettings };})()`, {
    self: { chrome: { storage: { local: { get: async (defaults) => ({...defaults,...saved}), set: async (next) => { Object.assign(saved,next);await save(next); } } } } },
    document: { querySelector: $ }, dismissOnOutsideClick, DEFAULT_MODEL: 'mock-model', AbortController, setTimeout, clearTimeout, ...extra,
  });
  return { $, openSettings, loadSettings };
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


test('automatic local translation defaults on for both new and existing Gemini settings',async()=>{
  for(const saved of [{},{geminiKey:'existing-key',geminiModel:'existing-model'}]){
    const f=fixture(async()=>{},saved),settings=await f.loadSettings();
    assert.equal(settings.autoTranslate,true);
    if(saved.geminiKey)assert.equal(settings.geminiKey,saved.geminiKey);
  }
});
test('automatic translation can be disabled and enabled persistently without losing Gemini settings',async()=>{
  const f=fixture();
  for(const enabled of [false,true]){
    const pending=f.openSettings({autoTranslate:!enabled,geminiKey:'mock-key',geminiModel:'mock-model'});
    f.$('#autoTranslate').checked=enabled;
    await f.$('form').onsubmit({submitter:{value:'save'}});
    assert.equal((await pending).autoTranslate,enabled);
    const saved=await f.loadSettings();
    assert.equal(saved.autoTranslate,enabled);
    assert.equal(saved.geminiKey,'mock-key');
    assert.equal(saved.geminiModel,'mock-model');
  }
});

 test('model selector switches presets and preserves saved custom IDs',async()=>{
  const f=fixture();const pending=f.openSettings({geminiKey:'key',geminiModel:'custom-model'});
  assert.equal(f.$('#modelPreset').value,'custom');assert.equal(f.$('#model').hidden,false);
  assert.equal(f.$('#model').value,'custom-model');
  f.$('#modelPreset').value='gemini-3.8-flash';f.$('#modelPreset').onchange();
  assert.equal(f.$('#model').hidden,true);
  await f.$('form').onsubmit({submitter:{value:'save'}});
  assert.equal((await pending).geminiModel,'gemini-3.8-flash');
 });

test('switching away from and back to custom retains the custom model draft',async()=>{
 const f=fixture();const pending=f.openSettings({geminiKey:'key',geminiModel:'my-model'});
 f.$('#modelPreset').value='gemini-3.8-flash';f.$('#modelPreset').onchange();
 f.$('#modelPreset').value='custom';f.$('#modelPreset').onchange();
 assert.equal(f.$('#model').value,'my-model');
 await f.$('form').onsubmit({submitter:{value:'save'}});
 assert.equal((await pending).geminiModel,'my-model');
});

test('connection test times out, aborts the request and ignores late results',async()=>{
 let timeout,signal,done,send;
 const f=fixture(async()=>{},{},{setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){},createGeminiTranslator:options=>{signal=options.signal;return {translateBatch:async(_,callback)=>{send=callback;await new Promise(r=>done=r);callback(0,'late');}};}});
 f.openSettings({geminiKey:'key',geminiModel:'gemini-3.8-flash'});
 const pending=f.$('#testKey').onclick();timeout();
 assert.equal(signal.aborted,true);assert.match(f.$('#testResult').textContent,/30秒/);
 done();await pending;assert.match(f.$('#testResult').textContent,/30秒/);assert.equal(f.$('#testKey').textContent,'接続テスト');
});
