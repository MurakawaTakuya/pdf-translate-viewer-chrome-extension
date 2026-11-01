// Source geometry stays local. Models copy tags; they never recreate these glyphs.
const strongMath = (part) => part.fi.math || /^[\p{Script=Greek}\p{Sm}]+$/u.test(part.str.trim());
const mathPart = (part) => strongMath(part) || part.fi.mathRoman
  && /^[\s\d.,:;()[\]{}=+−*/|^ˆˇ˘˙˚˜¯<>-]+$/.test(part.str);

export function sourceMathSpans(block) {
  const groups = [];
  let group = [];
  const flush = () => { if (group.some(strongMath)) groups.push(group); group = []; };
  for (const part of block.parts || []) {
    if (!mathPart(part)) { flush(); continue; }
    const before = group.at(-1);
    if (before && (Math.abs(part.base - before.base) > block.h * 0.55
      || /\S/.test(block.text.slice(before.end, part.start)))) flush();
    group.push(part);
  }
  flush();
  const spans = groups.map((parts) => {
    const start = parts[0].start, end = parts.at(-1).end;
    const main = parts.reduce((a, b) => b.h > a.h ? b : a);
    return { start, end, text: block.text.slice(start, end),
      x0: Math.min(...parts.map((p) => p.x0)) - 0.3,
      x1: Math.max(...parts.map((p) => p.x1)) + 0.3,
      top: Math.min(...parts.map((p) => p.top)) - 0.3,
      bottom: Math.max(...parts.map((p) => p.bottom)) + 0.3,
      base: main.base, h: block.h };
  });
  // A mixed prose/formula glyph run cannot safely be split using an estimated
  // character width. Keep such a paragraph in the original PDF instead.
  let uncertain = (block.parts || []).some((part) => /[\p{Script=Greek}\p{Sm}]/u.test(part.str)
    && !spans.some((span) => span.start <= part.start && span.end >= part.end));
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1], b = spans[i];
    if (Math.abs(a.base - b.base) > block.h * 0.55
      && !/\S/.test(block.text.slice(a.end, b.start))) uncertain = true;
  }
  return { spans, uncertain };
}

export const protectedTagPattern = () => /<([rm]_[a-f0-9]+)\/>/g;

export function protectedRuns(text, mathSpans = []) {
  const spans = new Map(mathSpans.map((span) => [span.id, span]));
  const runs = []; let offset = 0;
  for (const match of text.matchAll(protectedTagPattern())) {
    if (match.index > offset) runs.push({ text: text.slice(offset, match.index) });
    const span = spans.get(match[1]);
    if (!span) throw new Error('保護した数式が見つかりません');
    runs.push({ math: span }); offset = match.index + match[0].length;
  }
  if (offset < text.length) runs.push({ text: text.slice(offset) });
  return runs;
}

export function mathImage(row, span, document) {
  if (span.imageUrl && span.imageScale >= row.scale) return span.imageUrl;
  if (!row.srcCanvas || !row.scale) {
    if (span.imageUrl) return span.imageUrl;
    throw new Error('数式の原文画像が準備できていません');
  }
  const scale = row.scale, canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil((span.x1 - span.x0) * scale));
  canvas.height = Math.max(1, Math.ceil((span.bottom - span.top) * scale));
  canvas.getContext('2d').drawImage(row.srcCanvas, span.x0 * scale, span.top * scale,
    (span.x1 - span.x0) * scale, (span.bottom - span.top) * scale, 0, 0, canvas.width, canvas.height);
  span.imageUrl = canvas.toDataURL(); span.imageScale = scale;
  canvas.width = canvas.height = 0;
  return span.imageUrl;
}
