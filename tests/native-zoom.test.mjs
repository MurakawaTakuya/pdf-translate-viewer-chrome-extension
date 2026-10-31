import test from 'node:test';
import assert from 'node:assert/strict';
import { disableNativeZoom } from '../native-zoom.js';

test('Chrome zoom is disabled only for the current viewer tab without sending zoom factors', async () => {
  const calls = [];
  const tabs = {
    getCurrent: async () => ({ id: 42 }),
    setZoomSettings: async (id, settings) => { calls.push([id, settings]); },
    setZoom: () => assert.fail('must not change Chrome zoom or trigger its popover'),
  };
  assert.equal(await disableNativeZoom(tabs), true);
  assert.deepEqual(calls, [[42, { mode: 'disabled', scope: 'per-tab' }]]);
});

test('without the tab zoom API the PDF controls remain usable', async () => {
  assert.equal(await disableNativeZoom(undefined), false);
  assert.equal(await disableNativeZoom({ getCurrent: async () => null, setZoomSettings: () => assert.fail() }), false);
});
