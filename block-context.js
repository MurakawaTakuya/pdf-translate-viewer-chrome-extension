// Keep the original page/block identifiers and complete output targets. Only
// surrounding reference context is reduced for a paragraph-level request.
export function nearbyContext(pages, ids, neighbors = 2) {
  const selected = new Set(ids);
  const blocks = pages.flatMap((p) => p.blocks);
  const positions = blocks.flatMap((b, i) => (selected.has(b.id) ? [i] : []));
  if (!positions.length) throw new Error("翻訳対象の原文が見つかりません");
  let start = Math.min(...positions),
    end = Math.max(...positions);
  const paragraph = (b) =>
    b.kind === "paragraph" && b.translate !== false && !b.translationSkip;
  let count = 0;
  while (start > 0 && count < neighbors) {
    start--;
    if (paragraph(blocks[start])) count++;
  }
  count = 0;
  while (end + 1 < blocks.length && count < neighbors) {
    end++;
    if (paragraph(blocks[end])) count++;
  }
  const included = new Set(blocks.slice(start, end + 1));
  return pages.flatMap((p) => {
    const kept = p.blocks.filter((b) => included.has(b));
    return kept.length
      ? [
          {
            ...p,
            blocks: kept,
            contextScope: "nearby",
            startComplete: p.startComplete !== false && kept[0] === p.blocks[0],
            endComplete:
              p.endComplete !== false && kept.at(-1) === p.blocks.at(-1),
          },
        ]
      : [];
  });
}
