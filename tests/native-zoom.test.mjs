import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeZoom } from '../native-zoom.js';

test('manual tab zoom changes PDF scale and ignores own, stale and other-tab events', async () => {
  let listener, native = 1, pdf = 1, changes = 0;
  const calls = [];
  const tabs = {
    getCurrent: async () => ({ id: 42 }),
    setZoomSettings: async (id, settings) => { calls.push([id, settings]); },
    getZoom: async () => native,
    setZoom: async (id, value) => { assert.equal(id, 42); native = value; },
    onZoomChange: { addListener: (callback) => { listener = callback; } },
  };
  const controller = await createNativeZoom(tabs, { getZoom: () => pdf, onZoom: (value) => { pdf = value; changes++; } });
  assert.deepEqual(calls, [[42, { mode: 'manual', scope: 'per-tab' }]]);
  pdf = 1.5;
  await controller.sync(pdf);
  await listener({ tabId: 42, newZoomFactor: 1.5 });
  assert.equal(changes, 0);
  native = 2;
  await listener({ tabId: 99, newZoomFactor: 2 });
  await listener({ tabId: 42, newZoomFactor: 1.25 });
  assert.equal(changes, 0);
  await listener({ tabId: 42, newZoomFactor: 2 });
  assert.equal(pdf, 2);
  assert.equal(changes, 1);
  pdf = 0.1; // A small height-fit value must not be overwritten by Chrome's lower limit.
  await controller.sync(pdf);
  await listener({ tabId: 42, newZoomFactor: 0.25 });
  assert.equal(pdf, 0.1);
});

test('without the tab zoom API the PDF controls remain usable', async () => {
  assert.equal(await createNativeZoom(undefined, { getZoom: () => 1, onZoom() {} }), null);
});
