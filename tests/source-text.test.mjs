import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceTextLayer } from '../source-text.js';

function fixture() {
  const nodes = [], calls = [], tasks = [];
  let selection = null;
  const document = {
    getSelection: () => selection,
    createElement: () => ({ style: { setProperty: (key, value) => calls.push([key, value]) },
      remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); } }),
  };
  const source = { items: [{ str: 'Original English paragraph' }] };
  const row = { vp: { scale: .75 }, left: { appendChild: (node) => nodes.push(node) },
    page: { streamTextContent: (options) => { calls.push(options); return source; } } };
  class TextLayer {
    constructor(options) {
      Object.assign(this, options); tasks.push(this);
      this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    }
    render() { this.container.textContent = this.textContentSource.items[0].str; return this.promise; }
    cancel() { this.cancelled = true; this.reject(Object.assign(new Error('cancelled'), { name: 'AbortException' })); }
  }
  return { layer: createSourceTextLayer(row, TextLayer, document), nodes, calls, tasks, row, source,
    select: (value) => { selection = value; } };
}

test('source layer uses raw PDF text and page geometry, is independent of translation and reused after zoom', async () => {
  const f = fixture(), pending = f.layer.render();
  assert.equal(f.layer.render(), pending);
  assert.equal(f.tasks[0].textContentSource, f.source);
  assert.equal(f.tasks[0].viewport, f.row.vp);
  assert.equal(f.nodes[0].textContent, 'Original English paragraph');
  assert.deepEqual(f.calls, [['--scale-factor', '0.75'], { includeMarkedContent: true }]);
  f.tasks[0].resolve(); await pending;
  await f.layer.render();
  assert.equal(f.tasks.length, 1);
});

test('release cancels stale rendering without clearing a new text layer when a page returns', async () => {
  const f = fixture(), old = f.layer.render();
  f.layer.release();
  assert.equal(f.tasks[0].cancelled, true);
  const next = f.layer.render();
  await old;
  assert.equal(f.nodes.length, 1);
  f.tasks[1].resolve(); await next;
  assert.equal(f.layer.render(), next);
});

test('scrolling keeps selected source nodes and releases them after the selection is cleared', async () => {
  const f = fixture(), pending = f.layer.render();
  f.tasks[0].resolve(); await pending;
  const node = f.nodes[0];
  f.select({ isCollapsed: false, containsNode: (candidate) => candidate === node });
  f.layer.release();
  assert.equal(f.nodes[0], node);
  assert.equal(f.tasks[0].cancelled, undefined);
  f.select(null); f.layer.release();
  assert.equal(f.nodes.length, 0);
});

test('a text-layer error is reported and the next render can retry', async () => {
  const f = fixture(), pending = f.layer.render();
  f.tasks[0].reject(new Error('font failure'));
  await assert.rejects(pending, /font failure/);
  assert.equal(f.nodes.length, 0);
  const next = f.layer.render();
  f.tasks[1].resolve(); await next;
  assert.equal(f.nodes.length, 1);
});
