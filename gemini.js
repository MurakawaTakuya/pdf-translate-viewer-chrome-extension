// Gemini API（Interactions API）で、PDF全文を一括翻訳する
import { readTranslationStream } from './translation-stream.js';
import { buildKeyedTask, keyedPrompt, keyedMembers, taskIssue } from './keyed-translations.js';
import { readApiError, redactApiError } from './api-error.js';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const LANG_NAMES = {
  en: 'English', ja: 'Japanese', zh: 'Simplified Chinese', ko: 'Korean',
  fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian',
};

const systemPrompt = (src, dst, separated) => String.raw`You are a professional translator of academic papers.
${separated ? String.raw`The user sends a JSON object with two separate parts. "pages" contains the full extracted text of every PDF page, arranged in reading order, for reference context. "targets" is the authoritative list of translation tasks: each entry contains an integer "id", a "page", a "kind" (such as paragraph, heading, caption or footnote), and the exact source "text" to translate from ${src} into ${dst}. The target text also appears in the reference pages; this is intentional duplication, not an additional task. "translate_count" is the total number of targets, numbered consecutively from 1 to "translate_count" across the entire document, not per page.` : String.raw`The user sends a JSON object whose "pages" array contains text blocks extracted from every page of a PDF paper, in reading order. Every block has "text". A block with an integer "translate_id" is a target to translate from ${src} into ${dst}; blocks without "translate_id" are reference context only. "translate_count" is the total number of targets, numbered consecutively from 1 to "translate_count" across the entire document, not per page.`}

Rules:
- Translate faithfully into natural, idiomatic language. Preserve all information in the source; do not add explanations, omit details, summarize, or freely paraphrase in ways that change the meaning.
- Preserve negation and its scope, conditions, qualifications, uncertainty, comparisons, causal relationships, and the strength of every claim. Never turn a possibility into a certainty, an association into causation, or a limited claim into a general one.
- If fluency conflicts with fidelity, prioritize fidelity while making the wording as natural as possible. Preserve ambiguity in the source rather than resolving it through guesses or outside knowledge.
- Read the entire paper for context before translating. Use definitions, abbreviations, and surrounding passages from all pages to interpret each target block accurately.
${separated ? String.raw`- Return a JSON object of the form {"translations": [{"id": 1, "text": "translated text"}, {"id": 2, "text": "translated text"}, ...]}. Copy each target's "id" unchanged into "id", as an integer, and put its nonempty translation in "text". Return exactly "translate_count" items, covering every target once. Emit items in ascending "id" order. Never restart numbering on a new page, renumber IDs, merge, split, or skip target blocks, and never translate the reference pages as extra output. Only entries in "targets" are tasks. Before finishing, check that every target number has a translation. A sentence may continue across targets or pages: use the full reference pages to understand it, but translate only the exact source text of each target. Do not complete its sentence from neighboring targets or duplicate their content. The "kind" is a layout hint; the source text remains authoritative.` : String.raw`- Return a JSON object of the form {"translations": [{"id": 1, "text": "translated text"}, {"id": 2, "text": "translated text"}, ...]}. Copy each target's "translate_id" unchanged into "id", as an integer, and put its nonempty translation in "text". Return exactly "translate_count" items, covering every target once. Emit items in ascending "translate_id" order. Never restart numbering on a new page, renumber IDs, merge, split, or skip target blocks, and never include reference-only blocks. Before finishing, check that every target number has a translation. A sentence may continue across blocks or pages: use the neighboring text to understand it, but translate only the content belonging to each block, without duplicating or inventing text.`}
- Write in the formal written style of academic papers in ${dst}.${dst === 'Japanese' ? ' Use the plain "である" style, not "です・ます".' : ''}
- Write every mathematical expression, variable, and symbol as inline LaTeX enclosed in single dollar signs, such as $f_\omega(\cdot)$ or $x_{\text{img}}$, even if the source shows it as broken plain text (e.g. "f ω (·)" or "x img"). Do not use Markdown, and do not use LaTeX outside $...$.
- Keep these unchanged: citation markers such as [12] or (Smith et al., 2020), numbers with units, URLs, code, and names of models, datasets, methods, and acronyms (e.g. BERT, ImageNet, LoRA).
- Use the established technical terms of the field. If a term has no standard translation, keep the original word. Translate the same term the same way throughout the entire paper.
- For section headings and figure/table captions, keep the numbering (e.g. "3.1", "Figure 2:"${dst === 'Japanese' ? ' → "図2:", "Table 1:" → "表1:"' : ''}) and translate concisely.
- The text was extracted from a PDF and may contain broken hyphenation, ligature errors, or stray characters. Fix them silently in the translation.
- Every "text" value must be written in ${dst}; leave all target numbers unchanged. Never return the ${src} source text unchanged, except for blocks that consist only of names, numbers, or formulas.
- Output only the translations, with no notes or explanations.`;

// 段落IDの列挙・prefixItems・件数制約を含めず、文書サイズによらない固定スキーマにする。
// 番号の範囲・網羅性・重複・空欄は受信後に検証する。
const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: { translations: {
    type: 'array',
    items: {
      type: 'object',
      properties: { id: { type: 'integer' }, text: { type: 'string' } },
      required: ['id', 'text'],
      additionalProperties: false,
    },
  } },
  required: ['translations'],
  additionalProperties: false,
};

export function createKeyedGeminiTranslator(options) {
  return createGeminiTranslator({ ...options, outputFormat: 'keyed' });
}

export function createGeminiTranslator({ apiKey, model, sourceLanguage, targetLanguage, onWait = () => {}, signal, inputFormat = 'legacy', outputFormat = 'legacy', taskBuilder = buildKeyedTask, promptBuilder = keyedPrompt }) {
  // 分離入力は実生成で対応ずれが残ったため、評価用の明示指定だけで使う。
  const separated = inputFormat === 'separate-targets';
  const system = systemPrompt(LANG_NAMES[sourceLanguage] || sourceLanguage, LANG_NAMES[targetLanguage] || targetLanguage, separated);
  const src = LANG_NAMES[sourceLanguage] || sourceLanguage, dst = LANG_NAMES[targetLanguage] || targetLanguage;

  async function translateDocument(pages, translateIds, onTranslation = () => {}) {
    signal?.throwIfAborted();
    if (!translateIds.length) return new Map();
    const task = outputFormat === 'keyed' ? await taskBuilder(pages, translateIds, src, dst, signal) : null;
    const parseOutput = (body) => task?.parse ? task.parse(body) : task ? parseKeyed(body, task, src, dst) : parse(body, translateIds);
    // 全文は読解用、対象一覧は出力との対応用。座標と元のブロックIDはローカルに保持する。
    const numbers = new Map(translateIds.map((id, i) => [id, i + 1]));
    const targets = pages.flatMap((p) => p.blocks.filter((b) => numbers.has(b.id)).map((b) => ({
      id: numbers.get(b.id), page: p.page, kind: b.kind || 'paragraph', text: b.text,
    }))).sort((a, b) => a.id - b.id);
    const input = separated ? {
      pages: pages.map((p) => ({ page: p.page, text: p.blocks.map((b) => b.text).join('\n\n') })),
      targets,
      translate_count: translateIds.length,
    } : {
      pages: pages.map((p) => ({ page: p.page, blocks: p.blocks.map((b) => {
        const id = numbers.get(b.id);
        return id === undefined ? { text: b.text } : { translate_id: id, text: b.text };
      }) })),
      translate_count: translateIds.length,
    };
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, // キーはURLに載せない
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          system_instruction: task ? promptBuilder(system, src, dst) : system,
          input: JSON.stringify(task ? task.input : input),
          response_format: { type: 'text', mime_type: 'application/json', schema: task ? task.schema : TRANSLATION_SCHEMA },
          generation_config: { max_output_tokens: 65536 },
          stream: true,
          store: false, // Google側に会話を保存しない
        }),
      });
      if (res.ok && /text\/event-stream/i.test(res.headers.get('content-type') || '')) {
        const seen = new Set();
        const keyedValues = new Map();
        let unsafe = false;
        const collector = task?.collector ? task.collector(onTranslation) : task && keyedMembers((item) => {
          if (unsafe) return;
          const source = task.byKey.get(item.id);
          if (!source || seen.has(item.id) || !item.text.trim()) { unsafe = true; return; }
          seen.add(item.id);
          keyedValues.set(item.id, item.text);
          if (!taskIssue(task, item.id, keyedValues, src, dst)) {
            for (const key of task.groups.get(item.id)) onTranslation(task.byKey.get(key).id, task.displayText ? task.displayText(key, keyedValues.get(key)) : keyedValues.get(key));
          }
        });
        const streamed = await readTranslationStream(res, { signal, ...(collector ? { onText: (text) => collector.append(text) } : {}), onItem: (item) => {
          if (unsafe) return;
          if (!validTranslation(item, translateIds.length) || seen.has(item.id)) { unsafe = true; return; }
          seen.add(item.id);
          onTranslation(translateIds[item.id - 1], item.text);
        } });
        signal?.throwIfAborted();
        const body = { status: streamed.status, steps: [{ type: 'model_output', content: [{ type: 'text', text: streamed.text }] }] };
        return parseOutput(body);
      }
      if (res.ok) return parseOutput(await res.json().catch(() => ({})));
      const err = redactApiError(await readApiError(res), apiKey);

      // レート制限・一時的なエラーは待って再試行
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const sec = retryDelay(res, err) ?? 5 * 2 ** attempt;
        onWait(`${res.status === 429 ? 'レート制限中' : 'サーバーが混雑中'}… ${Math.ceil(sec)}秒後に再試行します`);
        await wait(sec * 1000, signal);
        continue;
      }
      throw new Error(describeError(res.status, err));
    }
  }

  return {
    translateDocument,
    ...(outputFormat === 'keyed' ? { async relatedTargets(pages, ids, id) {
      const task = await taskBuilder(pages, ids, src, dst, signal);
      const key = [...task.byKey].find(([, b]) => b.id === id)?.[0];
      if (!key) throw new Error('翻訳対象の段落が見つかりません');
      return task.groups.get(key).map((member) => task.byKey.get(member).id);
    } } : {}),
    // 設定画面の接続テスト用。本文の翻訳は translateDocument を使う。
    async translateBatch(texts, onEach) {
      const blocks = texts.map((text, i) => ({ id: String(i), text }));
      const out = await translateDocument([{ page: 1, blocks }], blocks.map((b) => b.id));
      for (let i = 0; i < texts.length; i++) {
        if (onEach(i, out.get(String(i))) === false) return;
      }
    },
  };
}

class BadOutput extends Error {}

function validTranslation(item, count) {
  return item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 2
    && Number.isInteger(item.id) && item.id >= 1 && item.id <= count
    && typeof item.text === 'string' && !!item.text.trim();
}

// 訳抜けだけなら、検証済みの応答を画面内に保持して手動補完に使える。
// 原文や訳文がconsole.errorやJSONに展開されないようprivateフィールドにする。
export class MissingTranslationsError extends BadOutput {
  #partial;
  #missing;
  #issues;
  constructor(message, partial, missing, issues = []) {
    super(message);
    this.name = 'MissingTranslationsError';
    this.#partial = partial;
    this.#missing = missing;
    this.#issues = issues.map((issue) => ({ ...issue }));
  }
  get partialTranslations() { return new Map(this.#partial); }
  get missingIds() { return [...this.#missing]; }
  get issues() { return this.#issues.map((issue) => ({ ...issue })); }
}

function parseKeyed(body, task, src, dst) {
  if (body.status === 'incomplete') throw new BadOutput('全文の翻訳が途中で切れました（出力上限など）。完了した翻訳としては表示しません');
  if (body.status && body.status !== 'completed') throw new BadOutput(`翻訳が完了しませんでした（${body.status}）`);
  const text = (body.steps || []).filter((s) => s.type === 'model_output').flatMap((s) => s.content || [])
    .filter((c) => c.type === 'text').map((c) => c.text).join('');
  let entries;
  try { const collector = keyedMembers(); collector.append(text); entries = collector.finish(); }
  catch { throw new BadOutput('翻訳応答の形式が不正です。全文を再試行してください'); }
  const seen = new Set(), out = new Map(), values = new Map(entries.map((b) => [b.id, b.text]));
  let extra = 0, duplicate = 0, empty = 0, citation = 0, unchanged = 0, protectedIssues = 0;
  for (const { id, text: value } of entries) {
    const source = task.byKey.get(id);
    if (!source) extra++;
    if (seen.has(id)) duplicate++;
    seen.add(id);
    if (!value.trim()) { empty++; continue; }
    if (!source) continue;
    const issue = taskIssue(task, id, values, src, dst);
    if (issue === 'citation') citation++;
    else if (issue === 'unchanged') unchanged++;
    else if (issue === 'protected' || issue === 'math') protectedIssues++;
    else if (issue === 'pending') continue;
    else out.set(source.id, task.displayText ? task.displayText(id, value) : value);
  }
  const missing = [...task.byKey.values()].filter((source) => !out.has(source.id)).map((b) => b.id);
  if (extra || duplicate || empty) throw new BadOutput(`全文の翻訳を検証できませんでした（対象外${extra}件、重複${duplicate}件、空欄${empty}件）。全文を再試行してください`);
  if (missing.length) {
    const issues = [...task.byKey].filter(([, source]) => !out.has(source.id)).map(([key, source]) => ({
      id: source.id, reason: values.has(key) ? taskIssue(task, key, values, src, dst) || 'missing' : 'missing',
      source: source.text, translated: values.get(key) || '',
    }));
    throw new MissingTranslationsError(`全文の翻訳を検証できませんでした（必要${task.byKey.size}件／受信${entries.length}件、補完対象${missing.length}件、参照番号不一致${citation}件、未翻訳${unchanged}件${protectedIssues ? `、保護データ不一致${protectedIssues}件` : ''}）。有効な訳文を保持しています。対象だけ再翻訳できます`, out, missing, issues);
  }
  return out;
}

function parse(body, ids) {
  if (body.status === 'incomplete') throw new BadOutput('全文の翻訳が途中で切れました（出力上限など）。完了した翻訳としては表示しません');
  if (body.status && body.status !== 'completed') throw new BadOutput(`翻訳が完了しませんでした（${body.status}）`);
  const text = (body.steps || [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  let translations;
  try { translations = JSON.parse(text)?.translations; } catch { throw new BadOutput('応答を読み取れませんでした'); }
  if (!Array.isArray(translations)) {
    throw new BadOutput('翻訳応答の形式が不正です（番号と訳文の配列が必要です）。全文を再試行してください');
  }
  const out = new Map();
  let extra = 0, duplicate = 0, empty = 0, invalid = 0;
  for (const item of translations) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'text')) { invalid++; continue; }
    const { id, text: value } = item;
    if (!Number.isInteger(id)) { invalid++; continue; }
    if (id < 1 || id > ids.length) extra++;
    if (out.has(id)) duplicate++;
    if (typeof value !== 'string') invalid++;
    else if (!value.trim()) empty++;
    out.set(id, value);
  }
  const missingIds = ids.filter((_, i) => !out.has(i + 1));
  const missing = missingIds.length;
  if (missing || extra || duplicate || empty || invalid || translations.length !== ids.length) {
    // 原文・訳文・APIキーはエラーに含めず、再現時に原因を区別できる件数だけを表示する。
    const details = [`必要${ids.length}件／受信${translations.length}件`, `不足${missing}件`, `対象外${extra}件`, `重複${duplicate}件`, `空欄${empty}件`, `形式不正${invalid}件`];
    const message = `全文の翻訳を検証できませんでした（${details.join('、')}）。`;
    if (missing && !extra && !duplicate && !empty && !invalid && translations.length === ids.length - missing) {
      const partial = new Map(ids.flatMap((id, i) => out.has(i + 1) ? [[id, out.get(i + 1)]] : []));
      throw new MissingTranslationsError(`${message}受信済みの訳文を保持しています。不足分だけ再翻訳できます`, partial, missingIds);
    }
    throw new BadOutput(`${message}全文を再試行してください`);
  }
  // 応答順は使わず、検証済みの番号から元のブロックIDに戻す。
  return new Map(ids.map((id, i) => [id, out.get(i + 1)]));
}

function wait(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function retryDelay(res, err) {
  const h = Number(res.headers.get('retry-after'));
  if (h > 0) return h;
  const d = err.details?.find((x) => x.retryDelay)?.retryDelay; // 例: "17s"
  return d ? parseFloat(d) : null;
}

function describeError(status, err) {
  const msg = err.message || '';
  const reason = err.details?.find((x) => x.reason)?.reason || '';
  if (reason === 'API_KEY_INVALID' || /API key not valid/i.test(msg)) return 'APIキーが正しくありません';
  if (status === 404 || /not found|is not supported/i.test(msg)) return `モデルが見つかりません（${msg}）`;
  if (status === 403) return `アクセスが拒否されました（${msg}）`;
  if (status === 429) return 'レート制限・利用上限に達しました。しばらく待ってから再度お試しください';
  return `Gemini APIエラー ${status}: ${msg || '不明なエラー'}`;
}
