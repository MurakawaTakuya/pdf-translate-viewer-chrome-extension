// 訳文中の $…$（LaTeXの数式）を、読みやすい文字＋下付き・上付きに変換する
// 例: "$f_\omega(\cdot)$" → [{t:'f'}, {t:'ω', s:'sub'}, {t:'(·)'}]
// 画面表示（viewer.js）とPDF保存（export.js）の両方で使う

const SYMBOLS = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  varrho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  cdot: "·",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  ast: "∗",
  star: "⋆",
  circ: "∘",
  bullet: "•",
  odot: "⊙",
  otimes: "⊗",
  oplus: "⊕",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  sim: "∼",
  simeq: "≃",
  equiv: "≡",
  propto: "∝",
  ll: "≪",
  gg: "≫",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  setminus: "∖",
  emptyset: "∅",
  varnothing: "∅",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  lor: "∨",
  wedge: "∧",
  vee: "∨",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  sum: "∑",
  prod: "∏",
  int: "∫",
  oint: "∮",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  gets: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  iff: "⇔",
  implies: "⇒",
  mapsto: "↦",
  uparrow: "↑",
  downarrow: "↓",
  ldots: "…",
  cdots: "⋯",
  dots: "…",
  vdots: "⋮",
  ell: "ℓ",
  hbar: "ℏ",
  top: "⊤",
  bot: "⊥",
  perp: "⊥",
  angle: "∠",
  prime: "′",
  langle: "⟨",
  rangle: "⟩",
  lvert: "|",
  rvert: "|",
  vert: "|",
  mid: "|",
  lVert: "‖",
  rVert: "‖",
  Vert: "‖",
  "|": "‖",
  lbrace: "{",
  rbrace: "}",
  "{": "{",
  "}": "}",
  "%": "%",
  $: "$",
  "&": "&",
  "#": "#",
  _: "_",
  quad: " ",
  qquad: "  ",
  ",": " ",
  ":": " ",
  ";": " ",
  "!": "",
  " ": " ",
  max: "max",
  min: "min",
  log: "log",
  exp: "exp",
  sin: "sin",
  cos: "cos",
  tan: "tan",
  arg: "arg",
  argmax: "argmax",
  argmin: "argmin",
  sup: "sup",
  inf: "inf",
  lim: "lim",
  det: "det",
  tr: "tr",
  softmax: "softmax",
  mathbb: "", // mathbb は下で特別扱い
};
const BLACKBOARD = {
  R: "ℝ",
  N: "ℕ",
  Z: "ℤ",
  Q: "ℚ",
  C: "ℂ",
  E: "𝔼",
  P: "ℙ",
  1: "𝟙",
};
const STYLE_ONLY = new Set([
  "text",
  "textrm",
  "textit",
  "textbf",
  "mathrm",
  "mathbf",
  "mathit",
  "mathsf",
  "mathtt",
  "mathcal",
  "mathscr",
  "mathfrak",
  "operatorname",
  "boldsymbol",
  "bm",
  "mbox",
  "emph",
]);
const IGNORED = new Set([
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "displaystyle",
  "textstyle",
  "limits",
  "nolimits",
]);
// 後ろに来る文字と離さない記号（例: \nabla A → ∇A）
const PREFIX = new Set(["nabla", "partial", "neg", "sum", "prod", "int"]);
const ACCENTS = {
  hat: "\u0302",
  widehat: "\u0302",
  bar: "\u0304",
  overline: "\u0304",
  tilde: "\u0303",
  widetilde: "\u0303",
  dot: "\u0307",
  ddot: "\u0308",
};

// 文字列全体 → runs（{t: 文字列, s: '' | 'sub' | 'sup'} の配列）
export function toRuns(text) {
  const runs = [];
  // $$…$$ / $…$ / \(…\) を数式として扱う。対応する $ がなければ普通の文字
  const re = /\$\$([\s\S]+?)\$\$|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g;
  let last = 0,
    m;
  while ((m = re.exec(text))) {
    const body = m[1] ?? m[2] ?? m[3];
    if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(body)) continue; // 中に日本語がある → 数式ではない（例: 「$5 です」）
    if (m.index > last) push(runs, text.slice(last, m.index), "");
    for (const r of parseMath(body)) push(runs, r.t, r.s);
    last = re.lastIndex;
  }
  if (last < text.length) push(runs, text.slice(last), "");
  return runs;
}

// 表示用の平文（下付き・上付きの区別をなくしたもの）
export const toPlain = (text) =>
  toRuns(text)
    .map((r) => r.t)
    .join("");

function push(runs, t, s) {
  if (!t) return;
  const prev = runs.at(-1);
  if (prev && prev.s === s) prev.t += t;
  else runs.push({ t, s });
}

// LaTeXの数式（$ の中身）を runs にする
function parseMath(src) {
  let i = 0;
  const out = [];

  // 1つの要素（文字・コマンド・{…}）を読んで runs で返す
  function atom(level) {
    const c = src[i];
    if (c === "{") {
      i++;
      const r = seq(level, "}");
      i++; // '}'
      return r;
    }
    if (c === "\\") {
      i++;
      let name = src[i] || "";
      if (/[A-Za-z]/.test(name)) {
        const m = /^[A-Za-z]+/.exec(src.slice(i));
        name = m[0];
      }
      i += name.length;
      if (PREFIX.has(name)) while (src[i] === " ") i++;
      return command(name, level);
    }
    i++;
    if (c === "~") return [{ t: " ", s: level }];
    return [{ t: c, s: level }];
  }

  function arg(level) {
    while (src[i] === " ") i++;
    return i < src.length ? atom(level) : [];
  }
  const flat = (runs) => runs.map((r) => r.t).join("");

  function command(name, level) {
    if (IGNORED.has(name)) return [];
    if (STYLE_ONLY.has(name)) return arg(level);
    if (name === "mathbb") {
      const inner = flat(arg(level));
      return [
        { t: [...inner].map((ch) => BLACKBOARD[ch] || ch).join(""), s: level },
      ];
    }
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const a = flat(arg(level)),
        b = flat(arg(level));
      const wrap = (x) => ([...x].length > 1 ? `(${x})` : x);
      return [{ t: `${wrap(a)}/${wrap(b)}`, s: level }];
    }
    if (name === "sqrt") {
      const a = flat(arg(level));
      return [{ t: `√${[...a].length > 1 ? `(${a})` : a}`, s: level }];
    }
    if (ACCENTS[name]) {
      const a = flat(arg(level));
      return [{ t: a + ACCENTS[name], s: level }];
    }
    if (name === "vec") return arg(level);
    if (name in SYMBOLS) return [{ t: SYMBOLS[name], s: level }];
    return [{ t: name, s: level }]; // 知らないコマンドは名前だけ残す
  }

  // 閉じ括弧（end）まで読む。_ と ^ はここで処理する
  function seq(level, end) {
    const runs = [];
    while (i < src.length && src[i] !== end) {
      const c = src[i];
      if (c === "_" || c === "^") {
        i++;
        // 下付きの中の下付きなどは、同じ高さにまとめる
        const s = level || (c === "_" ? "sub" : "sup");
        runs.push(...arg(s).map((r) => ({ t: r.t, s })));
        continue;
      }
      if (c === " " && !level) {
        // 数式中の空白は、単語の区切りとして1つだけ残す
        i++;
        if (runs.length && !/\s$/.test(runs.at(-1).t))
          runs.push({ t: " ", s: "" });
        continue;
      }
      runs.push(...atom(level));
    }
    return runs;
  }

  for (const r of seq("", undefined)) push(out, r.t, r.s);
  return out;
}
