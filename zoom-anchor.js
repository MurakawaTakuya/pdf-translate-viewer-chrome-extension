// 操作中の見た目と、CSS zoom確定後の中央寄せ・横スクロール範囲を一致させる。
export function horizontalZoomShift({ left, width, pointer, start, end }, scale) {
  if (![left, width, pointer, start, end, scale].every(Number.isFinite) || width <= 0 || end <= start || scale <= 0) return 0;
  const available = end - start, nextWidth = width * scale;
  const pointerLeft = pointer + (left - pointer) * scale;
  let nextLeft;
  if (nextWidth <= available) {
    // 左右に余白がある間は、操作中から中央を維持する。
    nextLeft = start + (available - nextWidth) / 2;
  } else {
    // 余白がなくなる倍率までは中央。その境界からマウス中心に切り替える。
    nextLeft = width <= available
      ? pointer + (start - pointer) * (nextWidth / available)
      : pointerLeft;
    // 縮小中に左右の端を超えて空白ができないよう、確定後と同じ範囲に収める。
    nextLeft = Math.max(end - nextWidth, Math.min(start, nextLeft));
  }
  return nextLeft - pointerLeft;
}
