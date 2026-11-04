// One required property per source block. Keep the source beside its value's schema.
import { pageContinuations } from "./translation-continuations.js";
export async function buildKeyedTask(
  pages,
  ids,
  sourceLanguage,
  targetLanguage,
  signal
) {
  if (new Set(ids).size !== ids.length)
    throw new Error("翻訳対象の識別子が重複しています");
  const used = new Set(),
    keys = new Map();
  for (const id of ids) {
    signal?.throwIfAborted();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(id)
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    let length = 6,
      key;
    do {
      key = hash.slice(0, length++);
    } while (used.has(key));
    used.add(key);
    keys.set(id, key);
  }
  signal?.throwIfAborted();
  const sources = new Map(
    pages.flatMap((page) => page.blocks.map((b) => [b.id, b]))
  );
  const positions = new Map(
    pages.flatMap((page) =>
      page.blocks.map((b, index) => [b.id, { page: page.page, index }])
    )
  );
  const byKey = new Map(
    ids.map((id) => {
      const source = sources.get(id);
      if (!source) throw new Error("翻訳対象の原文が見つかりません");
      return [keys.get(id), { id, ...source }];
    })
  );
  // A number and its unit can be split into adjacent PDF fragments. Validate
  // their citations together so Japanese word order may move a sentence's marker.
  // Do not join arbitrary lower-case labels or whole paragraphs.
  const groups = new Map([...byKey.keys()].map((key) => [key, [key]]));
  const entries = [...byKey];
  for (let i = 0; i + 1 < entries.length; i++) {
    const [key, a] = entries[i],
      [next, b] = entries[i + 1];
    const before = positions.get(a.id),
      after = positions.get(b.id);
    if (
      sourceLanguage === "English" &&
      a.kind === "paragraph" &&
      b.kind === "paragraph" &&
      before.page === after.page &&
      after.index === before.index + 1 &&
      /\d(?:[\d,.]*\d)?$/.test(a.text.trim()) &&
      /^(?:iterations|epochs|steps|samples|images|tokens|seconds|minutes|hours|days)\b/.test(
        b.text.trim()
      )
    ) {
      const group = [...groups.get(key), next];
      for (const member of group) groups.set(member, group);
    }
  }
  const fixedCitations = new Map();
  if (sourceLanguage === "English")
    for (const { a, b, fixedA, fixedB } of pageContinuations(pages)) {
      const key = keys.get(a.id),
        next = keys.get(b.id);
      // Do not widen an existing number/unit group or infer a group from only
      // the requested subset of the document's paragraphs.
      if (
        !key ||
        !next ||
        groups.get(key).length !== 1 ||
        groups.get(next).length !== 1
      )
        continue;
      const group = [key, next];
      for (const member of group) groups.set(member, group);
      fixedCitations.set(key, citationList(fixedA));
      fixedCitations.set(next, citationList(fixedB));
    }
  return {
    byKey,
    groups,
    fixedCitations,
    input: {
      pages: pages.map((p) => ({
        page: p.page,
        blocks: p.blocks.map((b) =>
          keys.has(b.id)
            ? { translate_id: keys.get(b.id), text: b.text }
            : { text: b.text }
        ),
      })),
      translate_count: ids.length,
    },
    schema: {
      type: "object",
      properties: Object.fromEntries(
        [...byKey].map(([key, b]) => [
          key,
          {
            type: "string",
            description: `Translate this ${b.kind || "paragraph"} from ${sourceLanguage} into ${targetLanguage}. Exact source to translate: ${JSON.stringify(b.text)}. Do not add content from other blocks.`,
          },
        ])
      ),
      required: [...byKey.keys()],
      additionalProperties: false,
    },
  };
}

export function keyedPrompt(system, sourceLanguage, targetLanguage) {
  return system
    .replace(
      /^The user sends.*$/m,
      `The user sends a JSON object whose "pages" array contains all PDF text blocks in reading order. Every block has "text". A block with a string "translate_id" is a target to translate from ${sourceLanguage} into ${targetLanguage}; blocks without "translate_id" are reference context only. Target identifiers are opaque labels, not numbers. "translate_count" is the total number of targets.`
    )
    .replace(
      /^- Return a JSON object.*$/m,
      '- Return one JSON object mapping each target identifier directly to its translated string, for example {"a3c9f1": "translated text", "c2a481": "another translation"}. Each required property belongs only to the input block whose "translate_id" exactly matches that property name. Preserve every identifier and return exactly one nonempty translation for each. Never merge, split, renumber, skip or substitute blocks. Use the entire paper to understand a sentence that continues across blocks or pages, but translate only the source content of the matching block. Do not complete its sentence using source content from another block. Never output reference-only blocks.'
    )
    .replace(
      /^- Every "text" value.*$/m,
      `- Every translation value must be written in ${targetLanguage}; copy the property keys unchanged. Never return ${sourceLanguage} source unchanged except blocks consisting only of names, numbers or formulas.`
    );
}

// Incrementally scan string members without losing duplicates to JSON.parse.
export function keyedMembers(onItem = () => {}) {
  let text = "",
    position = 0,
    state = "object",
    start = 0,
    escaped = false,
    key;
  const entries = [];
  return {
    append(chunk) {
      text += chunk;
      for (; position < text.length && state !== "invalid"; position++) {
        const char = text[position];
        if (state === "key-string" || state === "value-string") {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\") {
            escaped = true;
            continue;
          }
          if (char !== '"') continue;
          let value;
          try {
            value = JSON.parse(text.slice(start, position + 1));
          } catch {
            state = "invalid";
            continue;
          }
          if (state === "key-string") {
            key = value;
            state = "colon";
          } else {
            const item = { id: key, text: value };
            entries.push(item);
            onItem(item);
            state = "separator";
          }
          continue;
        }
        if (/\s/.test(char)) continue;
        if (state === "object" && char === "{") state = "key";
        else if (state === "key" && char === "}") state = "done";
        else if (state === "key" && char === '"') {
          start = position;
          state = "key-string";
        } else if (state === "colon" && char === ":") state = "value";
        else if (state === "value" && char === '"') {
          start = position;
          state = "value-string";
        } else if (state === "separator" && char === ",") state = "key";
        else if (state === "separator" && char === "}") state = "done";
        else state = "invalid";
      }
    },
    finish() {
      // Includes trailing commas, wrong root types, suffixes and unfinished strings.
      JSON.parse(text);
      if (state !== "done") throw new Error("invalid-keyed-object");
      return entries;
    },
  };
}

const citationList = (text) =>
  [
    ...text
      .normalize("NFKC")
      .matchAll(
        /\[(\d+(?:\s*[-–—]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)*)\]/g
      ),
  ].flatMap((m) =>
    m[1].split(",").flatMap((part) => {
      const range = part
        .trim()
        .split(/\s*[-–—]\s*/)
        .map(Number);
      if (range.length === 1) return range;
      const [first, last] = range;
      // Bound work for untrusted PDF strings; huge/descending ranges remain literal markers.
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        last < first ||
        last - first > 10000
      )
        return [`range:${part.trim()}`];
      return Array.from({ length: last - first + 1 }, (_, i) => first + i);
    })
  );
const citations = (text) => citationList(text).sort().join(",");

export function blockIssue(source, translated, sourceLanguage, targetLanguage) {
  if (citations(source.text) !== citations(translated)) return "citation";
  if (
    sourceLanguage === "English" &&
    targetLanguage !== "English" &&
    source.text.normalize("NFKC").trim() === translated.normalize("NFKC").trim()
  ) {
    // Names/numbers/formulas may stay unchanged; descriptive English headings may not.
    const ordinary =
      source.text.match(
        /\b(?:a|an|the|with|without|from|for|of|in|into|and|or|is|are|was|were|to|by)\b/gi
      ) || [];
    const section = source.text.replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, "").trim();
    const descriptive =
      ordinary.length ||
      /^(?:abstract|introduction|background|overview|methods|results|discussion|conclusions?|references|appendix|acknowledg(?:e)?ments|experiments|evaluation|related work|implementation details)$/i.test(
        section
      );
    // Captions are explanatory prose too. Bibliographies and author/affiliation
    // paragraphs may retain publication names, so do not reject them by length.
    if (["heading", "title", "caption"].includes(source.kind) && descriptive)
      return "unchanged";
  }
  return null;
}

export function taskIssue(task, key, values, src, dst) {
  if (task.issue) return task.issue(key, values);
  const group = task.groups.get(key);
  if (group.some((member) => !values.has(member))) return "pending";
  if (group.length === 1)
    return blockIssue(task.byKey.get(key), values.get(key), src, dst);
  const source = group.map((member) => task.byKey.get(member).text).join(" ");
  const translated = group.map((member) => values.get(member)).join(" ");
  if (citations(source) !== citations(translated)) return "citation";
  for (const member of group) {
    const remaining = citationList(values.get(member));
    for (const fixed of task.fixedCitations?.get(member) || []) {
      const index = remaining.indexOf(fixed);
      if (index < 0) return "citation";
      remaining.splice(index, 1);
    }
  }
  return null;
}
