import test from "node:test";
import assert from "node:assert/strict";
import { dismissOnOutsideClick } from "../dialog.js";

test("outside clicks dismiss a dialog but inside clicks and text-selection drags do not", () => {
  const handlers = new Map();
  const dialog = {
    open: true,
    getBoundingClientRect: () => ({
      left: 100,
      right: 400,
      top: 100,
      bottom: 300,
    }),
    addEventListener: (type, fn) => {
      assert.equal(handlers.has(type), false);
      handlers.set(type, fn);
    },
    close() {
      this.open = false;
    },
  };
  dismissOnOutsideClick(dialog);
  dismissOnOutsideClick(dialog); // Reopening settings must not attach duplicate handlers.
  const event = (x, y, target = dialog) => ({
    target,
    clientX: x,
    clientY: y,
    button: 0,
  });
  const click = (down, up = down) => {
    handlers.get("pointerdown")(down);
    handlers.get("click")(up);
  };
  click(event(200, 200));
  assert.equal(dialog.open, true);
  click(event(200, 200, {}), event(50, 50));
  assert.equal(dialog.open, true); // Text selection started inside.
  click(event(50, 50), event(200, 200));
  assert.equal(dialog.open, true);
  handlers.get("pointerdown")(event(50, 50));
  handlers.get("pointercancel")();
  handlers.get("click")(event(50, 50));
  assert.equal(dialog.open, true);
  click(event(50, 50));
  assert.equal(dialog.open, false);
});
