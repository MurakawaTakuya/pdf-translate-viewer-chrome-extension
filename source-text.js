// A selectable PDF.js text layer over the unchanged original canvas.
export function createSourceTextLayer(row, TextLayer, document) {
  let layer = null, task = null, pending = null;
  return {
    render() {
      if (pending) return pending; // CSS zoom scales this layer with the page.
      const container = document.createElement('div');
      container.className = 'source-text-layer';
      container.style.setProperty('--scale-factor', String(row.vp.scale));
      const next = new TextLayer({
        container, viewport: row.vp,
        textContentSource: row.page.streamTextContent({ includeMarkedContent: true }),
      });
      layer = container;
      task = next;
      row.left.appendChild(container);
      pending = next.render().catch((error) => {
        if (task !== next) return; // A released render must not erase its replacement.
        container.remove();
        layer = task = pending = null;
        if (error.name !== 'AbortException') throw error;
      });
      return pending;
    },
    release() {
      const selection = document.getSelection?.();
      // Scrolling while selecting must not destroy the selected text nodes.
      if (layer && selection && !selection.isCollapsed && selection.containsNode(layer, true)) return;
      task?.cancel();
      layer?.remove();
      layer = task = pending = null;
    },
  };
}
