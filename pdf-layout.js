import * as pdfjsLib from './lib/pdf.min.mjs';
import { sourceMathSpans } from './protected-spans.js';

function fontInfo(page, styles, fontName) {
  let f = null;
  try { if (page.commonObjs.has(fontName)) f = page.commonObjs.get(fontName); } catch {}
  const name = f?.name || '';
  const family = styles[fontName]?.fontFamily || '';
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) && v >= lo && v <= hi ? v : d);
  return {
    bold: !!(f?.bold || f?.black) || /bold|black|heavy|semibold|demi|medi|CMBX|CMMIB|-B$/i.test(name),
    sans: family === 'sans-serif' || /sans|helvet|arial|gothic|verdana|calibri/i.test(name),
    math: /CMMI|CMSY|CMEX|MSAM|MSBM|STIX.*Math|MathItalic|MathSymbols/i.test(name),
    mathRoman: /CMR\d|CMSS\d|CMBX\d/i.test(name),
    ascent: clamp(f?.ascent, 0.6, 1.1, 0.85),
    descent: clamp(-(f?.descent ?? NaN), 0.1, 0.4, 0.25),
  };
}

export async function extractBlocks(r) {
  const tc = await r.page.getTextContent();
  const fonts = {};
  const font = (n) => (fonts[n] ??= fontInfo(r.page, tc.styles, n));

  // 1) テキスト片を画面座標に変換（回転した文字＝arXivの縦書きIDなどは除外）
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = pdfjsLib.Util.transform(r.vp.transform, it.transform);
    const h = Math.abs(d);
    if (h < 1 || a <= 0 || Math.abs(b) + Math.abs(c) > h * 0.05) continue;
    if (tc.styles[it.fontName]?.vertical) continue;
    const fi = font(it.fontName);
    items.push({
      x0: e, x1: e + it.width * r.vp.scale, base: f, h, str: it.str, fi,
      top: f - h * fi.ascent, bottom: f + h * fi.descent,
    });
  }

  // 2) PDF内部の描画順に依存せず、座標から行と読み順を組み立てる。
  const lines = orderLines(makeLines(items));

  // 3) 行を段落ブロックにまとめる
  const blocks = [];
  let bk = null;
  for (const l of lines) {
    if (bk && canJoin(bk, l)) {
      const prev = bk.lines.at(-1);
      bk.pitch ??= l.base - prev.base;
      bk.lines.push(l);
      bk.x0 = Math.min(bk.x0, l.x0);
      bk.x1 = Math.max(bk.x1, l.x1);
      bk.top = Math.min(bk.top, l.top);
      bk.bottom = Math.max(bk.bottom, l.bottom);
    } else {
      bk = { lines: [l], h: l.h, pitch: null, x0: l.x0, x1: l.x1, top: l.top, bottom: l.bottom };
      blocks.push(bk);
    }
  }

  const body = bodyFontSize(blocks);
  for (const b of blocks) {
    let text = '';
    b.parts = [];
    let chars = 0, boldChars = 0, sansChars = 0;
    for (const l of b.lines) {
      const separator = !text || /[a-z]-$/.test(text) && /^[a-z]/.test(l.text) ? '' : ' ';
      const offset = text.length + separator.length;
      text += separator + l.text;
      b.parts.push(...l.parts.map((part) => ({ ...part, lineBase:l.base, start: offset + part.start, end: offset + part.end })));
      chars += l.chars; boldChars += l.boldChars; sansChars += l.sansChars;
    }
    b.text = text;
    b.bold = boldChars > chars / 2;
    b.sans = sansChars > chars / 2;
    b.align = alignOf(b, r.vp.width);
    b.translate = shouldTranslate(b, body);
    b.kind = blockKind(b, body);
    const math = sourceMathSpans(b);
    b.mathSpans = math.spans;
    b.mathUncertain = math.uncertain;
  }
  return blocks;
}

function canJoin(bk, l) {
  const prev = bk.lines.at(-1);
  if (Math.abs(l.h - bk.h) > bk.h * 0.2) return false;          // 文字サイズが違う
  // 太字タイトルと通常書体の本文が同じキャプション内に混在する。
  // 書体が変わっても、キャプションの続きか混在行なら幾何条件で判断する。
  const caption = /^(?:Fig(?:ure)?\.?|Table)\s*\d+[.:]/i.test(bk.lines[0].text);
  const mixed = prev.boldChars > 0 && prev.boldChars < prev.chars;
  if (l.bold !== prev.bold && !caption && !mixed) return false;
  if (/^(?:Fig(?:ure)?\.?|Table)\s*\d+[.:]/i.test(l.text)) return false;
  if (Math.min(l.x1, bk.x1) <= Math.max(l.x0, bk.x0)) return false; // 横に重ならない（別の段）
  const pitch = l.base - prev.base;
  if (bk.pitch == null ? (pitch < bk.h * 0.9 || pitch > bk.h * 2.0)
                       : Math.abs(pitch - bk.pitch) > bk.h * 0.3) return false; // 行送りが違う
  // 中央揃えのタイトルなどは行の長さが違っても続けてよい
  if (isCentered([prev, l], bk.h)) return true;
  // 文が終わった行が「短い」か、次の行が字下げされている → 新しい段落
  const right = Math.max(bk.x1, l.x1);
  const prevShort = prev.x1 < right - bk.h * 1.5;
  const indented = l.x0 > bk.x0 + bk.h * 0.8;
  if (/[.!?:。．！？：]['")\]]*$/.test(prev.text) && (prevShort || indented)) return false;
  // 1行だけの短い行（見出しなど）の後に長い行が来た
  if (bk.lines.length === 1 && prev.x1 - prev.x0 < (l.x1 - l.x0) * 0.6) return false;
  return true;
}

// どの行も左右の余白が同じ（＝中央揃え）
function isCentered(lines, h) {
  const L = Math.min(...lines.map((l) => l.x0));
  const R = Math.max(...lines.map((l) => l.x1));
  return lines.some((l) => l.x0 - L > h)
    && lines.every((l) => Math.abs((l.x0 - L) - (R - l.x1)) < h);
}

function alignOf(b, pageWidth) {
  // 1行だけでページ中央にある（タイトル・著者名など）
  if (b.lines.length < 2) return Math.abs((b.x0 + b.x1) / 2 - pageWidth / 2) < b.h * 2 ? 'center' : 'left';
  const w = b.x1 - b.x0;
  if (isCentered(b.lines, b.h)) return 'center';
  const full = b.lines.slice(0, -1).filter((l) => l.x1 - l.x0 > w * 0.9).length;
  return full >= (b.lines.length - 1) / 2 ? 'justify' : 'left';
}

// ページ内で一番多く使われている文字サイズ＝本文サイズ
function bodyFontSize(blocks) {
  const hist = new Map();
  for (const b of blocks) for (const l of b.lines) {
    const k = Math.round(l.h * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + l.chars);
  }
  let best = 10, max = -1;
  for (const [k, v] of hist) if (v > max) { max = v; best = k; }
  return best;
}

// 図中のラベル・数式・表のセルなどは訳さず原文のまま残す
function shouldTranslate(b, body) {
  const t = b.text;
  const nonSpace = t.replace(/\s/g, '').length;
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 2 || letters / nonSpace < 0.55) return false;
  const words = (t.match(/\p{L}{2,}/gu) || []).length;
  if (b.lines.length > 1 && words / b.lines.length < 2.5) return false; // 表の列など
  if (b.h < body * 0.7 && words < 6) return false;                      // 図の中の小さい文字
  return words >= 3 || ((b.bold || b.h > body * 1.15) && words >= 1);
}

// 座標を使った行再構成。PDF内部で列や書体の描画順が変わっても行を壊さない。
function makeLines(items) {
  // A detached accent must follow its base glyph's band, even when a nearby
  // caption in the other column is closer to the accent's painted baseline.
  // Keep all painted coordinates intact for cropping; this changes grouping only.
  const bandBase = new Map();
  for (const accent of items.filter((it) => it.fi.mathRoman && /^[ˆˇ˘˙˚˜¯]$/.test(it.str.trim()))) {
    const bases = items.filter((base) => base !== accent && base.fi.math && [...base.str.trim()].length === 1
      && accent.h / base.h >= 0.7 && accent.h / base.h <= 1.3
      && accent.base <= base.base + base.h * 0.15 && accent.base >= base.base - base.h * 0.5
      && Math.min(accent.x1, base.x1) - Math.max(accent.x0, base.x0) >= Math.min(accent.x1 - accent.x0, base.x1 - base.x0) * 0.5);
    if (bases.length === 1) bandBase.set(accent, bases[0].base);
  }
  const groupingBase = (it) => bandBase.get(it) ?? it.base;
  const bands = [];
  for (const it of [...items].sort((a, b) => groupingBase(a) - groupingBase(b) || a.x0 - b.x0)) {
    let band = bands.at(-1);
    if (!band || Math.abs(groupingBase(it) - band.base) >= Math.max(it.h, band.h) * 0.5) {
      band = { base: groupingBase(it), h: it.h, main: it.str.length, items: [] };
      bands.push(band);
    }
    band.items.push(it);
    if (it.str.length > band.main) { band.base = groupingBase(it); band.h = it.h; band.main = it.str.length; }
  }
  const lines = [];
  for (const band of bands) {
    let ln = null;
    for (const it of band.items.sort((a, b) => a.x0 - b.x0)) {
      // TeX paints a hat and its base glyph on top of one another. That narrow
      // overlap is one mathematical atom, not a second column or text line.
      const accent = ln && Math.abs(it.base - ln.base) < Math.max(ln.h, it.h) * 0.3
        && it.x0 >= ln.x1 - ln.h && it.x0 <= ln.x1
        && (/[ˆˇ˘˙˚˜¯]\s*$/.test(ln.text) && it.fi.math && [...it.str.trim()].length === 1 && it.x1 - it.x0 <= it.h * 1.5
          || /^[ˆˇ˘˙˚˜¯]$/.test(it.str.trim()) && ln.parts.at(-1)?.fi.math
            && [...ln.parts.at(-1).str.trim()].length === 1);
      const same = ln && (it.x0 >= ln.x1 - ln.h * 0.5 || accent)
        && it.x0 - ln.x1 < Math.max(ln.h, it.h) * 1.5;
      if (!same) {
        if (ln) lines.push(ln);
        ln = { ...it, text: it.str, parts: [{ ...it, start: 0, end: it.str.length }], main: it.str.length, chars: 0, boldChars: 0, sansChars: 0 };
      } else {
        const space = it.x0 - ln.x1 > ln.h * 0.12 && !/\s$/.test(ln.text) && !/^\s/.test(it.str);
        const start = ln.text.length + (space ? 1 : 0);
        ln.text += (space ? ' ' : '') + it.str;
        ln.parts.push({ ...it, start, end: ln.text.length });
        ln.x1 = Math.max(ln.x1, it.x1);
        ln.top = Math.min(ln.top, it.top);
        ln.bottom = Math.max(ln.bottom, it.bottom);
        if (it.str.length > ln.main) { ln.main = it.str.length; ln.h = it.h; ln.base = it.base; }
      }
      const n = it.str.replace(/\s/g, '').length;
      ln.chars += n;
      if (it.fi.bold) ln.boldChars += n;
      if (it.fi.sans) ln.sansChars += n;
    }
    if (ln) lines.push(ln);
  }
  for (const l of lines) {
    const leading = l.text.length - l.text.trimStart().length;
    l.text = l.text.trim();
    l.parts = l.parts.map((part) => ({ ...part,
      sourceStart: Math.max(0, leading - part.start),
      sourceEnd: part.str.length - Math.max(0, part.end - leading - l.text.length),
      start: Math.max(0, part.start - leading), end: Math.min(l.text.length, part.end - leading),
    }));
    l.bold = l.boldChars > l.chars / 2;
  }
  return lines;
}

// 再帰的な空白分割。列間の空白なら左列→右列、全幅の見出しや図表の
// 上下の空白なら上→下に分ける。通常の行間では分割しない。
function orderLines(lines, depth = 0) {
  if (lines.length < 2 || depth > 32) return [...lines].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const h = [...lines].sort((a, b) => a.h - b.h)[Math.floor(lines.length / 2)].h;
  const gaps = (lo, hi) => {
    const sorted = [...lines].sort((a, b) => a[lo] - b[lo]);
    let edge = sorted[0][hi];
    const result = [];
    for (const l of sorted.slice(1)) {
      if (l[lo] > edge) result.push({ middle: (edge + l[lo]) / 2, size: l[lo] - edge });
      edge = Math.max(edge, l[hi]);
    }
    return result;
  };
  const left = Math.min(...lines.map((l) => l.x0)), right = Math.max(...lines.map((l) => l.x1));
  const vertical = gaps('x0', 'x1').filter((g) => g.size >= Math.max(12, h * 1.4)
    && g.middle - left > (right - left) * 0.2 && right - g.middle > (right - left) * 0.2)
    .sort((a, b) => b.size - a.size)[0];
  if (vertical) {
    return [...orderLines(lines.filter((l) => l.x1 < vertical.middle), depth + 1),
      ...orderLines(lines.filter((l) => l.x0 > vertical.middle), depth + 1)];
  }
  const horizontal = gaps('top', 'bottom').filter((g) => g.size > h * 0.7).sort((a, b) => b.size - a.size)[0];
  if (horizontal) {
    return [...orderLines(lines.filter((l) => l.bottom < horizontal.middle), depth + 1),
      ...orderLines(lines.filter((l) => l.top > horizontal.middle), depth + 1)];
  }
  return [...lines].sort((a, b) => a.base - b.base || a.x0 - b.x0);
}

function blockKind(b, body) {
  if (/^(?:Fig(?:ure)?\.?|Table)\s*\d+[.:]/i.test(b.text)) return 'caption';
  if (b.h > body * 1.3 && b.align === 'center') return 'title';
  if (b.lines.length <= 2 && b.bold && b.text.length < 160) return 'heading';
  if (b.h < body * 0.8 && b.lines.length > 1) return 'footnote';
  return b.translate ? 'paragraph' : 'other';
}
