// PDF受信の実測値を表示する。解析・描画には架空の割合を割り当てない。
export function createPdfLoadProgress(bar, fill, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let active = false, preparing = false, fraction = 0, hideTimer;
  const clearTimer = () => { if (hideTimer !== undefined) cancel(hideTimer); hideTimer = undefined; };
  const describe = (text) => { bar.setAttribute('aria-valuetext', text); bar.title = text; };
  const modes = (indeterminate, processing) => {
    bar.classList.toggle('indeterminate', indeterminate);
    bar.classList.toggle('preparing', processing);
  };
  return {
    start() {
      clearTimer();
      active = true; preparing = false; fraction = 0;
      bar.hidden = false;
      bar.removeAttribute('aria-valuenow');
      modes(true, false);
      fill.style.transform = 'scaleX(0)';
      describe('PDFを取得中…');
    },
    update({ loaded, total } = {}) {
      if (!active || preparing) return;
      if (!Number.isFinite(loaded) || loaded < 0 || !Number.isFinite(total) || total <= 0) return;
      // 範囲読み込みなどで通知が前後しても、バーを後退させない。
      fraction = Math.max(fraction, Math.min(1, loaded / total));
      const percent = Math.round(fraction * 100);
      modes(false, false);
      fill.style.transform = `scaleX(${fraction})`;
      bar.setAttribute('aria-valuenow', String(percent));
      describe(`PDFを取得中… ${percent}%受信済み`);
    },
    prepare() {
      if (!active) return;
      preparing = true;
      modes(false, true);
      fill.style.transform = 'scaleX(1)';
      bar.removeAttribute('aria-valuenow');
      describe('PDFの表示を準備中…');
    },
    complete() {
      if (!active) return;
      active = false;
      modes(false, false);
      fill.style.transform = 'scaleX(1)';
      bar.setAttribute('aria-valuenow', '100');
      describe('PDFの読み込みが完了しました');
      clearTimer();
      hideTimer = schedule(() => { bar.hidden = true; hideTimer = undefined; }, 300);
    },
    fail() {
      active = false;
      clearTimer();
      modes(false, false);
      bar.hidden = true;
      bar.removeAttribute('aria-valuenow');
    },
  };
}
