// Experimental output codec. The schema owns atom identity; model prose cannot
// delete or rename a reference, formula, or alphanumeric model identifier.
import { createGeminiTranslator, MissingTranslationsError } from "./gemini.js";
import {
  buildProtectedTask,
  withOriginalFallback,
} from "./protected-translator.js";
import { keyedPrompt, blockIssue } from "./keyed-translations.js";
import { protectedTagPattern } from "./protected-spans.js";
import { jsonMembers } from "./json-members.js";

const identifiers = () => /\b[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)*\b/g;
const namedNumber = (text) =>
  [...text.matchAll(identifiers())].filter((m) => /\d/.test(m[0]));
const identifierInventory = (text) =>
  namedNumber(text.normalize("NFKC"))
    .map((m) => m[0])
    .sort()
    .join("\n");
const decimals = (text) =>
  text
    .normalize("NFKC")
    .replaceAll("−", "-")
    .match(/[+-]?\d+\.\d+/g) || [];
function identifierRanges(text) {
  let normalized = "";
  const starts = [],
    ends = [];
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i)),
      part = char.normalize("NFKC");
    for (let j = 0; j < part.length; j++) {
      starts.push(i);
      ends.push(i + char.length);
    }
    normalized += part;
    i += char.length;
  }
  return namedNumber(normalized).map((m) => ({
    index: starts[m.index],
    end: ends[m.index + m[0].length - 1],
  }));
}
const object = (properties, description) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...(description ? { description } : {}),
});
const textField = { type: "string" };
const atomField = (source) =>
  object(
    { o: { type: "integer" }, t: textField },
    `Source atom: ${JSON.stringify(source)}. o is its Japanese occurrence rank; t is only the prose immediately before it. The original atom is inserted locally.`
  );
const sameKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const proseIssue = (text) =>
  typeof text !== "string" ||
  // eslint-disable-next-line no-control-regex -- Reject control characters in model output.
  /[\u0000-\u0009\u000b-\u001f\p{Script=Greek}\p{Sm}]|\$|\\[A-Za-z()[\]]|<\/?[A-Za-z][^>]*>/u.test(
    text.normalize("NFKC")
  ) ||
  namedNumber(text.normalize("NFKC")).length > 0;

function atomize(encoded) {
  const meaning = new Map(
    (encoded.protected_spans || []).map((s) => [s.tag, s])
  );
  const parts = [],
    atoms = [];
  let offset = 0;
  const atom = (value) => {
    const key = "a" + atoms.length;
    atoms.push({ key, ...value });
    parts.push({ atom: key, kind: value.kind, source: value.source });
  };
  const prose = (text) => {
    let start = 0;
    for (const match of identifierRanges(text)) {
      if (match.index > start)
        parts.push({ text: text.slice(start, match.index) });
      const end = match.end + (/[%％]/.test(text[match.end] || "") ? 1 : 0),
        literal = text.slice(match.index, end);
      atom({ kind: "literal", source: literal, display: literal });
      start = end;
    }
    if (start < text.length) parts.push({ text: text.slice(start) });
  };
  for (const match of encoded.text.matchAll(protectedTagPattern())) {
    prose(encoded.text.slice(offset, match.index));
    const span = meaning.get(match[0]);
    // A scientific coefficient must move with its exponent, not as free prose.
    const before = parts.at(-1),
      coefficient =
        span.kind === "math" &&
        /^[−-]?\d+$/.test(span.source) &&
        before?.text?.match(/\d+(?:\.\d+)?[eE]$/);
    if (coefficient) {
      before.text = before.text.slice(0, -coefficient[0].length);
      if (!before.text) parts.pop();
    }
    const prefix = coefficient ? coefficient[0] : "";
    atom({
      kind: span.kind,
      source: prefix + span.source,
      display: span.kind === "math" ? prefix + match[0] : span.source,
    });
    offset = match.index + match[0].length;
  }
  prose(encoded.text.slice(offset));
  return { parts, atoms };
}

export async function buildNodeTask(pages, ids, src, dst, signal) {
  const base = await buildProtectedTask(pages, ids, src, dst, signal),
    layouts = new Map(),
    properties = {};
  const keyedBlocks = new Map([...base.byKey].map(([key, b]) => [b.id, key]));
  const input = {
    pages: pages.map((page, p) => ({
      page: page.page,
      blocks: page.blocks.map((b, i) => {
        const key = keyedBlocks.get(b.id);
        if (!key) return { text: b.text };
        const layout = atomize(base.input.pages[p].blocks[i]);
        layouts.set(key, layout);
        const description = `Translate only this ${b.kind || "paragraph"} from ${src} into ${dst}: ${JSON.stringify(b.text)}. Use the full document for meaning; never borrow neighboring content.`;
        properties[key] = layout.atoms.length
          ? object(
              {
                ...Object.fromEntries(
                  layout.atoms.map((a) => [a.key, atomField(a.source)])
                ),
                tail: textField,
              },
              description
            )
          : { type: "string", description };
        return { translate_id: key, text: b.text, source_parts: layout.parts };
      }),
    })),
    translate_count: ids.length,
  };
  const decode = (key, value) => {
    const source = base.byKey.get(key),
      { atoms, parts } = layouts.get(key);
    let display = "",
      expanded = "",
      prose = "";
    if (!atoms.length) {
      if (proseIssue(value) || !value.trim()) return { issue: "node" };
      display = expanded = value;
    } else {
      if (
        !sameKeys(value, [...atoms.map((a) => a.key), "tail"]) ||
        proseIssue(value.tail)
      )
        return { issue: "node" };
      const ranked = [];
      for (const atom of atoms) {
        const v = value[atom.key];
        if (
          !sameKeys(v, ["o", "t"]) ||
          !Number.isSafeInteger(v.o) ||
          v.o < 0 ||
          v.o >= atoms.length ||
          proseIssue(v.t)
        )
          return { issue: "node" };
        ranked.push({ ...atom, ...v });
      }
      ranked.sort((a, b) => a.o - b.o);
      if (ranked.some((a, i) => a.o !== i)) return { issue: "node" };
      for (const a of ranked) {
        display += a.t + a.display;
        expanded += a.t + a.source;
        prose += a.t;
      }
      display += value.tail;
      expanded += value.tail;
      prose += value.tail;
      const ordinarySource = parts
        .filter((p) => p.text)
        .map((p) => p.text)
        .join(" ");
      // Names and bibliography text may remain English. Reject dropping all
      // ordinary prose; descriptive headings retain blockIssue's stricter check.
      if (/\p{L}{2}/u.test(ordinarySource) && !prose.trim())
        return { issue: "unchanged" };
    }
    if (identifierInventory(source.text) !== identifierInventory(expanded))
      return { issue: "node" };
    // Registered decimal scalars can otherwise be copied into ordinary prose
    // and inserted twice. Do not include integers: ordinary words such as
    // "twice" may naturally become 2回 next to an unrelated original integer 2.
    const originalNumbers = decimals(source.text),
      resultNumbers = decimals(expanded);
    for (const value of new Set(
      atoms
        .filter(
          (a) =>
            a.kind === "math" &&
            /^[+-]?\d+\.\d+$/.test(
              a.source.normalize("NFKC").replaceAll("−", "-")
            )
        )
        .map((a) => a.source.normalize("NFKC").replaceAll("−", "-"))
    )) {
      if (
        originalNumbers.filter((n) => n === value).length !==
        resultNumbers.filter((n) => n === value).length
      )
        return { issue: "node" };
    }
    // Numeric tuples can evade the identifier/Greek/operator guards. Count
    // their literal appearances as well as inserted originals so a copied
    // tuple cannot accompany the original image a second time.
    const compact = (text) => text.normalize("NFKC").replace(/\s+/g, ""),
      original = compact(source.text),
      result = compact(expanded);
    for (const atom of atoms) {
      const literal = compact(atom.source);
      if (
        atom.kind === "math" &&
        /^[([{].*[)\]}]$/.test(literal) &&
        /\d/.test(literal) &&
        original.split(literal).length !== result.split(literal).length
      )
        return { issue: "node" };
    }
    return { text: display, issue: blockIssue(source, expanded, src, dst) };
  };
  const collector = (onEach = () => {}) => {
    const seen = new Set();
    let unsafe = false;
    return jsonMembers(({ id, value }) => {
      if (unsafe) return;
      if (!base.byKey.has(id) || seen.has(id)) {
        unsafe = true;
        return;
      }
      seen.add(id);
      const result = decode(id, value);
      if (!result.issue) onEach(base.byKey.get(id).id, result.text);
    });
  };
  return {
    ...base,
    input,
    schema: object(properties),
    groups: new Map([...base.byKey.keys()].map((k) => [k, [k]])),
    layouts,
    decode,
    collector,
    parse(body) {
      if (body.status !== "completed")
        throw new Error("全文の翻訳が完了しませんでした");
      const text = (body.steps || [])
        .filter((s) => s.type === "model_output")
        .flatMap((s) => s.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      let entries;
      try {
        const c = jsonMembers();
        c.append(text);
        entries = c.finish();
      } catch {
        throw new Error("翻訳応答の形式が不正です。全文を再試行してください");
      }
      if (entries.some((e) => !base.byKey.has(e.id)))
        throw new Error("対象外の翻訳が含まれています");
      const values = new Map(entries.map((e) => [e.id, e.value])),
        out = new Map(),
        issues = [];
      for (const [key, source] of base.byKey) {
        const result = values.has(key)
          ? decode(key, values.get(key))
          : { issue: "missing" };
        if (result.issue)
          issues.push({
            id: source.id,
            reason: result.issue,
            source: source.text,
            translated: values.has(key) ? JSON.stringify(values.get(key)) : "",
          });
        else out.set(source.id, result.text);
      }
      if (issues.length)
        throw new MissingTranslationsError(
          `全文の翻訳を検証できませんでした（必要${ids.length}件／受信${entries.length}件、補完対象${issues.length}件）。有効な訳文を保持しています`,
          out,
          issues.map((i) => i.id),
          issues
        );
      return out;
    },
  };
}

export function nodePrompt(system, src, dst) {
  return (
    originalAtomPrompt(system, src, dst)
      .replace(
        /^- Return one JSON object.*$/m,
        '- Return the required JSON object. For a block with atoms, each required atom property has {"o": integer, "t": string}, followed by "tail": string. For a block without atoms, return its translated string. Each property belongs only to its matching source block.'
      )
      .replace(
        /^- Write every mathematical expression.*$/m,
        "- Math, references and alphanumeric identifiers are original atoms inserted by local code. Never write their source or any identifier/tag in prose fields. Never reconstruct math, LaTeX or dollar delimiters."
      )
      .replace(
        /^- The text was extracted.*$/m,
        "- Fix ordinary prose hyphenation only. Do not infer or repair original atoms."
      )
      .replace(
        /^- Every translation value.*$/m,
        `- Write the prose in ${dst}. Empty t/tail is allowed for adjacent atoms; a whole ordinary paragraph must still be translated.`
      ) +
    "\n- First compose the natural translation of the WHOLE matching block. Then assign each atom a unique Japanese occurrence rank o from 0 to k-1 and put only the prose immediately before that atom in t. Put all prose after the last atom in tail. Reordering atoms together with their claims is allowed. Do not translate source_parts independently: they identify positions in the original, not separate translation tasks.\n- Never omit a claim, condition or comparative qualifier. Less/fewer means a smaller amount, not none. Each atom must remain attached to its own claim. Do not duplicate a phrase across t fields or complete a sentence with neighboring source content."
  );
}

// Registered occurrences are inserted by code, not copied by the model. Keep
// the general preservation rule only for source content outside those atoms.
export function originalAtomPrompt(system, src, dst) {
  return keyedPrompt(system, src, dst).replace(
    /^- Keep these unchanged:.*$/m,
    "- Registered original atoms are restored by local code. Never repeat their source in prose fields. Preserve the spelling of unregistered names, numbers with units, URLs and code in ordinary prose."
  );
}

export function createNodeGeminiTranslator(options) {
  return withOriginalFallback(
    createGeminiTranslator({
      ...options,
      outputFormat: "keyed",
      taskBuilder: buildNodeTask,
      promptBuilder: nodePrompt,
    })
  );
}
