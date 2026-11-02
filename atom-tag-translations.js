// Experimental plain-string output: copy opaque atoms in fluent whole-block
// translations. No ranks, line protocol, or model-generated numeric atom order.
import { createGeminiTranslator, MissingTranslationsError } from "./gemini.js";
import { buildNodeTask, originalAtomPrompt } from "./node-translations.js";
import { withOriginalFallback } from "./protected-translator.js";
import { jsonMembers } from "./json-members.js";

const tags = () => /<n_[a-f0-9]+\/>/g;

export async function buildAtomTagTask(pages, ids, src, dst, signal) {
  const base = await buildNodeTask(pages, ids, src, dst, signal),
    byTag = new Map(),
    byKey = new Map(),
    properties = {};
  for (const [key, source] of base.byKey) {
    const layout = base.layouts.get(key),
      atomTags = new Map();
    for (const atom of layout.atoms) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${source.id}:${atom.key}`)
      );
      signal?.throwIfAborted();
      const hash = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      let length = 4,
        tag;
      do {
        tag = `<n_${hash.slice(0, length++)}/>`;
      } while (byTag.has(tag));
      atomTags.set(atom.key, tag);
      byTag.set(tag, atom);
    }
    const text = layout.parts
      .map((p) => (p.atom ? atomTags.get(p.atom) : p.text))
      .join("");
    byKey.set(key, { atomTags, text });
    properties[key] = {
      type: "string",
      description: `Translate only this ${source.kind || "paragraph"} from ${src} into ${dst}: ${JSON.stringify(text)}. Keep every opaque tag exactly once in this value and with its own claim. Never complete this block using another block's words.`,
    };
  }
  for (const page of pages)
    for (const block of page.blocks)
      if (/<n_[a-f0-9]+\/>/.test(block.text))
        throw new Error("原文が保護タグと競合しています");
  const input = {
    pages: base.input.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        if (!block.translate_id) return block;
        const { atomTags, text } = byKey.get(block.translate_id),
          layout = base.layouts.get(block.translate_id);
        return {
          translate_id: block.translate_id,
          text,
          kind: base.byKey.get(block.translate_id).kind || "paragraph",
          ...(layout.atoms.length
            ? {
                original_atoms: layout.atoms.map((atom) => ({
                  tag: atomTags.get(atom.key),
                  kind: atom.kind,
                  source: atom.source,
                })),
              }
            : {}),
        };
      }),
    })),
    translate_count: ids.length,
  };
  const decode = (key, value) => {
    if (typeof value !== "string" || !value.trim()) return { issue: "node" };
    const { atomTags } = byKey.get(key),
      found = [...value.matchAll(tags())];
    if (
      JSON.stringify(found.map((m) => m[0]).sort()) !==
      JSON.stringify([...atomTags.values()].sort())
    )
      return { issue: "node" };
    if (/<\/?[A-Za-z][^>]*>/.test(value.replace(tags(), "")))
      return { issue: "node" };
    if (!atomTags.size) return base.decode(key, value);
    const node = {};
    let offset = 0;
    for (const [rank, match] of found.entries()) {
      const atom = byTag.get(match[0]);
      node[atom.key] = { o: rank, t: value.slice(offset, match.index) };
      offset = match.index + match[0].length;
    }
    node.tail = value.slice(offset);
    return base.decode(key, node);
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
    schema: {
      type: "object",
      properties,
      required: [...base.byKey.keys()],
      additionalProperties: false,
    },
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
            translated: values.get(key) || "",
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

export function atomTagPrompt(system, src, dst) {
  return (
    originalAtomPrompt(system, src, dst)
      .replace(
        /^- Write every mathematical expression.*$/m,
        "- Original atoms use opaque <n_.../> tags. Copy each tag exactly once in the matching translated string, together with its own claim. Never spell out its source a second time or reconstruct mathematical expressions."
      )
      .replace(
        /^- The text was extracted.*$/m,
        "- Fix ordinary prose hyphenation only. Never infer, complete or repair an original atom."
      )
      .replace(
        /^- Registered original atoms.*$/m,
        "- original_atoms entries identify the meanings of tags for context. In the translation emit only the exact tag, never its source. Preserve unregistered names, numbers with units, URLs and code."
      ) +
    "\n- Translate each WHOLE target block into natural prose, preserving its original boundary. If its last sentence is cut off by a column or page break, translate only the fragment present here. Do not move the missing predicate or continuation into this value; it belongs to its own target. Likewise do not repeat the preceding block. Tags may move with their own claims for natural grammar. Never return a tag list instead of translating the prose.\n- Preserve each condition and comparative qualifier. Less/fewer means a smaller amount, not none. Keep the model, training method and measured result attached to the same claim as in the matching source block."
  );
}

export function createAtomTagGeminiTranslator(options) {
  return withOriginalFallback(
    createGeminiTranslator({
      ...options,
      outputFormat: "keyed",
      taskBuilder: buildAtomTagTask,
      promptBuilder: atomTagPrompt,
    })
  );
}
