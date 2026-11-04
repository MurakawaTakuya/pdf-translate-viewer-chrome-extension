// Only explicit word breaks at consecutive page boundaries share citations.
// Floats may precede the continuation, but unrelated prose must never be skipped.
const body = (b) =>
  b.kind === "paragraph" && b.translate !== false && !b.translationSkip;
const float = (b) =>
  ["figure", "table"].includes(b.translationSkip) ||
  b.kind === "caption" ||
  (b.kind === "other" && /^\d+$/.test(b.text.trim()));

export function pageContinuations(pages) {
  const pairs = [];
  for (let i = 0; i + 1 < pages.length; i++) {
    const before = pages[i],
      after = pages[i + 1];
    if (after.page !== before.page + 1) continue;
    if (before.endComplete === false || after.startComplete === false) continue;
    const aIndex = before.blocks.findLastIndex(body);
    const bIndex = after.blocks.findIndex(body);
    if (aIndex < 0 || bIndex < 0) continue;
    const a = before.blocks[aIndex],
      b = after.blocks[bIndex];
    if (
      a.mathUncertain ||
      b.mathUncertain ||
      !/[a-z]{2,}-$/.test(a.text.trim()) ||
      !/^[a-z]{2,}\b/.test(b.text.trim()) ||
      !before.blocks.slice(aIndex + 1).every(float) ||
      !after.blocks.slice(0, bIndex).every(float)
    )
      continue;
    // Be conservative: even abbreviations/decimal points restrict the movable
    // region. Sentence segmenters can miss stops before names such as iBOT.
    const lastStop = [...a.text.matchAll(/[.!?]/g)].at(-1)?.index ?? -1;
    const firstStop = b.text.search(/[.!?]/);
    // Everything outside the punctuation around the seam keeps its citations.
    pairs.push({
      a,
      b,
      fixedA: a.text.slice(0, lastStop + 1),
      fixedB: firstStop < 0 ? "" : b.text.slice(firstStop + 1),
    });
  }
  return pairs;
}
