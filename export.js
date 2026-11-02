// 翻訳済みブロックを元のPDFに書き込み、保存用のPDFを作る（保存ボタンを押したときだけ読み込まれる）
import {
  PDFDocument,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  setCharacterSpacing,
} from "./lib/pdf-lib.esm.min.js";
// self.fontkit を定義する。
// 注意：lib/fontkit.umd.min.js は1か所だけ手を入れてある（サブセットの loca を常に long 形式にする
// `this.loca={offsets:[],version:1}`）。元のままだと奇数長のグリフで位置がずれ、一部の文字が消える。
import "./lib/fontkit.umd.min.js";
import { toRuns } from "./math.js";
import { protectedRuns, ensureMathImages } from "./protected-spans.js";

const FONT_FILES = {
  serif: "fonts/BIZUDPMincho-Regular.ttf",
  sans: "fonts/BIZUDPGothic-Regular.ttf",
  bold: "fonts/BIZUDPGothic-Bold.ttf",
};
const SCRIPT_SIZE = 0.7; // 下付き・上付きの文字の大きさ
// フォントにない記号は、近い文字で代用する（同梱フォントは ℝ などを持っていない）
const FALLBACK = {
  ϑ: "θ",
  "∼": "~",
  "↦": "→",
  "⋯": "…",
  "⋮": "…",
  "⊤": "T",
  "⊙": "◎",
  "∘": "○",
  "⟨": "〈",
  "⟩": "〉",
  ℝ: "R",
  ℕ: "N",
  ℤ: "Z",
  ℚ: "Q",
  ℂ: "C",
  "𝔼": "E",
  ℙ: "P",
  "𝟙": "1",
  ℏ: "h",
  "⋆": "*",
};
const PAD = 1.5; // 画面表示（placeBlock）と同じ余白（px）
// 行頭に来てはいけない文字（ぶら下げる）
const NO_START =
  /^[、。，．,.)）」』】〕〉》！？!?:：;；ー～ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ・]$/;
// 欧文の単語（和文の文字・空白以外の連続）はまとめて扱い、途中で改行しない
const TOKEN =
  /[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]+|\s|./gu;

// mode: 'orig' | 'ja' | 'both'
export async function exportPdf(mode, srcBytes, rows, onProgress = () => {}) {
  if (mode === "orig") return srcBytes;

  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  doc.registerFontkit(self.fontkit);
  const fonts = {};
  const font = (kind) =>
    (fonts[kind] ??= fetch(FONT_FILES[kind])
      .then((res) => res.arrayBuffer())
      .then((buf) => doc.embedFont(buf, { subset: true })));

  const pages = doc.getPages();
  const mathImages = new Map();
  for (const r of rows) {
    onProgress(`PDFを作成中… ${r.index}/${rows.length}ページ`);
    const page = pages[r.index - 1];
    const spans = (r.blocks || [])
      .filter((b) => b.ja && !b.hidden)
      .flatMap((b) =>
        protectedRuns(b.ja, b.mathSpans).flatMap((p) =>
          p.math ? [p.math] : []
        )
      );
    await ensureMathImages(r, spans, globalThis.document);
    for (const b of r.blocks || []) {
      if (!b.ja || b.hidden) continue; // 訳を消した段落は原文のまま
      for (const part of protectedRuns(b.ja, b.mathSpans))
        if (part.math && !mathImages.has(part.math)) {
          // Embed only the glyph crop: clipping an embedded full page would duplicate
          // that page's hidden text once per formula in saved PDF search/copy.
          mathImages.set(part.math, await doc.embedPng(part.math.imageUrl));
        }
      drawBlock(
        page,
        await font(b.bold ? "bold" : b.sans ? "sans" : "serif"),
        b,
        r.vp,
        mathImages
      );
    }
  }
  onProgress("PDFを保存中…");
  const jaBytes = await doc.save();
  if (mode === "ja") return jaBytes;

  // 対訳：原文と訳文のページを交互に並べる
  const out = await PDFDocument.create();
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const ja = await PDFDocument.load(jaBytes);
  const idx = src.getPageIndices();
  const [a, b] = await Promise.all([
    out.copyPages(src, idx),
    out.copyPages(ja, idx),
  ]);
  for (const i of idx) {
    out.addPage(a[i]);
    out.addPage(b[i]);
  }
  return out.save();
}

function drawBlock(page, font, b, vp, mathImages) {
  // 画面座標（px, 下向き）→ PDF座標（pt, 上向き）
  const [ax, ay] = vp.convertToPdfPoint(b.x0 - PAD, b.top - PAD);
  const [bx, by] = vp.convertToPdfPoint(b.x1 + PAD, b.bottom + PAD);
  const left = Math.min(ax, bx),
    right = Math.max(ax, bx);
  const top = Math.max(ay, by),
    bottom = Math.min(ay, by);
  const boxW = right - left,
    boxH = top - bottom;
  const h = b.h / vp.scale;
  const ratio = b.pitch ? Math.min(1.6, Math.max(1.2, b.pitch / b.h)) : 1.2;

  // 枠に収まる最大の文字サイズを二分探索（画面の fitText と同じ考え方）
  const tokens = tokenize(b.ja, font, boxW / (h * 0.4), b.mathSpans);
  const need = (size) => {
    const n = wrap(tokens, boxW / size).length;
    return (n - 1) * size * ratio + size * 1.15;
  };
  let lo = h * 0.4,
    hi = h * 0.95;
  if (need(hi) <= boxH) lo = hi;
  else if (need(lo) <= boxH) {
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (need(mid) <= boxH) lo = mid;
      else hi = mid;
    }
  }
  const size = lo;
  const lines = wrap(tokens, boxW / size);
  const lh = size * ratio;
  const height = Math.max(boxH, need(size)); // 入りきらないときは下に伸ばす

  page.drawRectangle({
    x: left,
    y: top - height,
    width: boxW,
    height,
    color: toRgb(b.colors.bg),
  });

  const color = toRgb(b.colors.fg);
  let base = top - (lh - size) / 2 - size * 0.88; // 1行目のベースライン
  lines.forEach((line, i) => {
    const w = line.reduce((sum, t) => sum + t.w, 0) * size;
    let x = left;
    let cs = 0;
    if (b.align === "center") x = left + (boxW - w) / 2;
    else if (b.align === "justify" && i < lines.length - 1) {
      const n = line.reduce(
        (sum, t) => sum + (t.math ? 1 : [...t.t].length),
        0
      );
      const extra = (boxW - w) / Math.max(1, n - 1);
      if (extra > 0 && extra < size * 0.3) cs = extra;
    }
    if (cs) page.pushOperators(pushGraphicsState(), setCharacterSpacing(cs));
    for (const seg of segments(line)) {
      if (seg.math) {
        drawOriginalMath(
          page,
          mathImages.get(seg.math),
          seg.math,
          x,
          base,
          size
        );
        x += seg.w * size + cs;
        continue;
      }
      const sz = seg.s ? size * SCRIPT_SIZE : size;
      const dy =
        seg.s === "sub" ? -size * 0.18 : seg.s === "sup" ? size * 0.38 : 0;
      page.drawText(seg.t, { x, y: base + dy, size: sz, font, color });
      x += font.widthOfTextAtSize(seg.t, sz) + cs * [...seg.t].length;
    }
    if (cs) page.pushOperators(popGraphicsState());
    base -= lh;
  });
}

// 訳文 → 文字サイズ1あたりの幅つきトークン（s: 下付き 'sub' / 上付き 'sup'）。長すぎる単語は1文字ずつに
function tokenize(text, font, maxW1, mathSpans) {
  const safe = safeText(font);
  const out = [];
  for (const part of protectedRuns(
    text.replace(/\s+/g, " ").trim(),
    mathSpans
  )) {
    if (part.math) {
      out.push({
        math: part.math,
        t: "",
        s: "",
        w: (part.math.x1 - part.math.x0) / part.math.h,
      });
      continue;
    }
    for (const run of toRuns(part.text)) {
      const k = run.s ? SCRIPT_SIZE : 1;
      for (const t of safe(run.t).match(TOKEN) || []) {
        const w = font.widthOfTextAtSize(t, 1) * k;
        if (w > maxW1 && [...t].length > 1) {
          for (const c of t)
            out.push({ t: c, w: font.widthOfTextAtSize(c, 1) * k, s: run.s });
        } else out.push({ t, w, s: run.s });
      }
    }
  }
  return out;
}

// フォントにない文字を代わりの文字に置き換える関数
const charsets = new WeakMap();
function safeText(font) {
  let set = charsets.get(font);
  if (!set) charsets.set(font, (set = new Set(font.getCharacterSet())));
  return (t) =>
    [...t]
      .map((c) => (set.has(c.codePointAt(0)) ? c : FALLBACK[c] || c))
      .join("");
}

// 貪欲に詰めて改行する（maxW はサイズ1あたりの幅）。下付き・上付きの直前では改行しない
function wrap(tokens, maxW) {
  const lines = [];
  let cur = [],
    w = 0;
  for (const tok of tokens) {
    const space = tok.t === " ";
    if (cur.length && w + tok.w > maxW && !NO_START.test(tok.t) && !tok.s) {
      lines.push(trimEnd(cur));
      cur = space ? [] : [tok];
      w = space ? 0 : tok.w;
    } else if (cur.length || !space) {
      cur.push(tok);
      w += tok.w;
    }
  }
  if (cur.length) lines.push(trimEnd(cur));
  return lines.length ? lines : [[]];
}

function trimEnd(line) {
  while (line.length && line.at(-1).t === " ") line.pop();
  return line;
}

// 同じ高さ（通常・下付き・上付き）の連続をまとめる
function segments(line) {
  const out = [];
  for (const tok of line) {
    const prev = out.at(-1);
    if (tok.math) {
      out.push(tok);
      continue;
    }
    if (prev && !prev.math && prev.s === tok.s) prev.t += tok.t;
    else out.push({ t: tok.t, s: tok.s });
  }
  return out;
}

function drawOriginalMath(page, image, span, x, baseline, size) {
  if (!image) throw new Error("数式の原文画像が見つかりません");
  const scale = size / span.h;
  page.drawImage(image, {
    x,
    y: baseline - (span.bottom - span.base) * scale,
    width: (span.x1 - span.x0) * scale,
    height: (span.bottom - span.top) * scale,
  });
}

const toRgb = ([r, g, b]) => rgb(r / 255, g / 255, b / 255);
