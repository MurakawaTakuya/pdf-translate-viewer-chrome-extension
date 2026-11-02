import test from "node:test";
import assert from "node:assert/strict";
import { disableNativeZoom } from "../native-zoom.js";

test("Chrome zoom is disabled only for the current viewer tab without sending zoom factors", async () => {
  const calls = [];
  const tabs = {
    getCurrent: async () => ({ id: 42 }),
    setZoomSettings: async (id, settings) => {
      calls.push([id, settings]);
    },
    setZoom: () =>
      assert.fail("must not change Chrome zoom or trigger its popover"),
  };
  assert.equal(await disableNativeZoom(tabs), true);
  assert.deepEqual(calls, [[42, { mode: "disabled", scope: "per-tab" }]]);
});

test("without the tab zoom API the PDF controls remain usable", async () => {
  assert.equal(await disableNativeZoom(undefined), false);
  assert.equal(
    await disableNativeZoom({
      getCurrent: async () => null,
      setZoomSettings: () => assert.fail(),
    }),
    false
  );
});

test("a MIME handler uses its supplied tab ID without depending on frame getCurrent behavior", async () => {
  const calls = [];
  const tabs = {
    getCurrent: () =>
      assert.fail("the MIME stream already identifies its containing tab"),
    setZoomSettings: async (...args) => calls.push(args),
  };
  assert.equal(await disableNativeZoom(tabs, 42), true);
  assert.deepEqual(calls, [[42, { mode: "disabled", scope: "per-tab" }]]);
});
