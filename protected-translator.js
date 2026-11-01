import { createGeminiTranslator, MissingTranslationsError } from './gemini.js';
import { buildKeyedTask, keyedPrompt, blockIssue } from './keyed-translations.js';
import { protectedTagPattern } from './protected-spans.js';

const citations = () => /\[\d+(?:\s*[-–—]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)*\]/g;

export async function buildProtectedTask(pages, ids, src, dst, signal) {
  const task = await buildKeyedTask(pages, ids, src, dst, signal);
  const records = new Map(), blocks = new Map(), used = new Set();
  const tag = async (kind, block, span) => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}:${block.id}:${span.start}`));
    signal?.throwIfAborted();
    const hex = [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
    let length = 4, id;
    do { id = `${kind}_${hex.slice(0, length++)}`; } while (used.has(id));
    used.add(id); return id;
  };
  for (const page of pages) for (const block of page.blocks) {
    signal?.throwIfAborted();
    if (/<[rm]_[a-f0-9]+\/>/.test(block.text)) throw new Error('原文が保護タグと競合しています');
    const spans = [...(block.mathSpans || []).map((span) => ({ ...span, kind: 'm', original: span }))];
    for (const match of block.text.matchAll(citations())) {
      const start = match.index, end = start + match[0].length;
      if (!spans.some((span) => span.start < end && span.end > start)) spans.push({ start, end, text: match[0], kind: 'r' });
    }
    spans.sort((a, b) => a.start - b.start);
    let previous = 0, masked = '';
    for (const span of spans) {
      if (span.start < previous || span.end <= span.start || block.text.slice(span.start, span.end) !== span.text) throw new Error('原文の保護範囲が不正です');
      const id = await tag(span.kind, block, span);
      if (span.original) span.original.id = id; // Shared with the local row for original-glyph rendering.
      records.set(id, { ...span, id, block: block.id });
      masked += block.text.slice(previous, span.start) + `<${id}/>`;
      previous = span.end;
    }
    masked += block.text.slice(previous);
    blocks.set(block.id, { masked, ids: [...records.values()].filter((r) => r.block === block.id).map((r) => r.id) });
  }
  const keys = new Map([...task.byKey].map(([key, block]) => [block.id, key]));
  task.input = {
    pages: pages.map((page) => ({ page: page.page, blocks: page.blocks.map((block) => ({
      ...(keys.has(block.id) ? { translate_id: keys.get(block.id) } : {}), text: blocks.get(block.id).masked,
      ...(blocks.get(block.id).ids.length ? { protected_spans: blocks.get(block.id).ids.map((id) => ({ tag: `<${id}/>`, kind: records.get(id).kind === 'm' ? 'math' : 'citation', source: records.get(id).text })) } : {}),
    })) })), translate_count: ids.length,
  };
  for (const [key, block] of task.byKey) {
    const source = blocks.get(block.id);
    task.schema.properties[key].description = `Translate this ${block.kind || 'paragraph'} from ${src} into ${dst}. Exact source: ${JSON.stringify(source.masked)}. Copy each protected tag once in this value, with its corresponding claim: ${source.ids.map((id) => `<${id}/>`).join(' ')}. Tags and their claims may move together for natural ${dst} grammar. Do not add content from other blocks. Never reconstruct math or emit LaTeX.`;
  }
  // A tag belongs to exactly one block. No group can silently absorb it.
  task.groups = new Map([...task.byKey.keys()].map((key) => [key, [key]]));
  const decode = (key, value) => {
    if (typeof value !== 'string') return { issue: 'pending' };
    const block = task.byKey.get(key), expected = blocks.get(block.id).ids;
    const found = [...value.matchAll(protectedTagPattern())].map((match) => match[1]);
    if (JSON.stringify([...expected].sort()) !== JSON.stringify([...found].sort())) return { issue: 'protected' };
    const rest = value.replace(protectedTagPattern(), '');
    if (/<\/?[A-Za-z][^>]*>|<\/?[rm]_|[rm]_[a-f0-9]{4,}/.test(rest)) return { issue: 'protected' };
    if (/[\u0000-\u0009\u000b-\u001f]|\$|\\[A-Za-z()[\]]/.test(value)) return { issue: 'math' };
    if (/[\p{Script=Greek}\p{Sm}]/u.test(rest)) return { issue: 'math' };
    const expanded = value.replace(protectedTagPattern(), (_match, id) => records.get(id).text);
    const text = value.replace(protectedTagPattern(), (match, id) => records.get(id).kind === 'r' ? records.get(id).text : match);
    return { text, expanded };
  };
  task.issue = (key, values) => {
    const decoded = decode(key, values.get(key));
    return decoded.issue || blockIssue(task.byKey.get(key), decoded.expanded, src, dst);
  };
  task.displayText = (key, text) => {
    const decoded = decode(key, text);
    if (decoded.issue) throw new Error('保護データを検証できませんでした');
    return decoded.text;
  };
  return task;
}

export function protectedPrompt(system, src, dst) {
  return keyedPrompt(system, src, dst)
    .replace(/^- Write every mathematical expression.*$/m, '- Math is rendered from the original PDF by local code. Copy every <m_.../> tag exactly once, including within prose. Never emit LaTeX, dollar delimiters, or a reconstructed expression. Do not add a second spelling of a tagged variable.')
    .replace(/^- The text was extracted.*$/m, '- Fix broken hyphenation in ordinary prose only. Never infer, complete, normalize or repair a protected math expression or reference.')
    + '\n- Each protected_spans entry is context: its source identifies the original math or bibliography reference. Output only its exact tag, never its source. Tags are atomic: never merge, split or rewrite them. Preserve each tag and its associated claim in the same target; their order may change for natural grammar. Preserve comparative scope: less/fewer means a smaller amount, not none.';
}

export function createProtectedGeminiTranslator(options) {
  const inner = createGeminiTranslator({ ...options, outputFormat: 'keyed', taskBuilder: buildProtectedTask, promptBuilder: protectedPrompt });
  return withOriginalFallback(inner);
}

export function withOriginalFallback(inner) {
  const split = splitProtectedTargets;
  return {
    ...inner,
    async translateDocument(pages, ids, onEach) {
      const { safe, originals } = split(pages, ids);
      try {
        const out = await inner.translateDocument(pages, safe, onEach);
        for (const id of originals) out.set(id, null);
        return out;
      } catch (error) {
        if (!(error instanceof MissingTranslationsError)) throw error;
        const partial = error.partialTranslations;
        for (const id of originals) partial.set(id, null);
        throw new MissingTranslationsError(error.message, partial, error.missingIds, error.issues);
      }
    },
    async relatedTargets(pages, ids, id) {
      const { safe, originals } = split(pages, ids);
      if (originals.includes(id)) throw new Error('数式の読み取りが不確かなため、この段落は原文で保持しています');
      return inner.relatedTargets(pages, safe, id);
    },
  };
}

export function splitProtectedTargets(pages, ids) {
  const unsafe = new Set(pages.flatMap((p) => p.blocks.filter((b) => b.mathUncertain
    // Literal dollars would also be ambiguous to the existing $...$ renderer.
    || [...b.text.matchAll(/\$/g)].some((match) => !b.mathSpans?.some((s) => match.index >= s.start && match.index < s.end))).map((b) => b.id)));
  return { safe: ids.filter((id) => !unsafe.has(id)), originals: ids.filter((id) => unsafe.has(id)) };
}
