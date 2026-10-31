// Gemini API（Interactions API）で、PDF全文を一括翻訳する
import { readTranslationStream } from './translation-stream.js';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const LANG_NAMES = {
  en: 'English', ja: 'Japanese', zh: 'Simplified Chinese', ko: 'Korean',
  fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian',
};

const systemPrompt = (src, dst) => String.raw`You are a professional translator of academic papers.
The user sends a JSON object whose "pages" array contains text blocks extracted from every page of a PDF paper, in reading order. Every block has "text". A block with an integer "translate_id" is a target to translate from ${src} into ${dst}; blocks without "translate_id" are reference context only. "translate_count" is the total number of targets, numbered consecutively from 1 to "translate_count" across the entire document, not per page.

Rules:
- Translate faithfully into natural, idiomatic language. Preserve all information in the source; do not add explanations, omit details, summarize, or freely paraphrase in ways that change the meaning.
- Preserve negation and its scope, conditions, qualifications, uncertainty, comparisons, causal relationships, and the strength of every claim. Never turn a possibility into a certainty, an association into causation, or a limited claim into a general one.
- If fluency conflicts with fidelity, prioritize fidelity while making the wording as natural as possible. Preserve ambiguity in the source rather than resolving it through guesses or outside knowledge.
- Read the entire paper for context before translating. Use definitions, abbreviations, and surrounding passages from all pages to interpret each target block accurately.
- Return a JSON object of the form {"translations": [{"id": 1, "text": "translated text"}, {"id": 2, "text": "translated text"}, ...]}. Copy each target's "translate_id" unchanged into "id", as an integer, and put its nonempty translation in "text". Return exactly "translate_count" items, covering every target once. Emit items in ascending "translate_id" order. Never restart numbering on a new page, renumber IDs, merge, split, or skip target blocks, and never include reference-only blocks. Before finishing, check that every target number has a translation. A sentence may continue across blocks or pages: use the neighboring text to understand it, but translate only the content belonging to each block, without duplicating or inventing text.
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

export function createGeminiTranslator({ apiKey, model, sourceLanguage, targetLanguage, onWait = () => {}, signal }) {
  const system = systemPrompt(LANG_NAMES[sourceLanguage] || sourceLanguage, LANG_NAMES[targetLanguage] || targetLanguage);

  async function translateDocument(pages, translateIds, onTranslation = () => {}) {
    signal?.throwIfAborted();
    if (!translateIds.length) return new Map();
    // 元の疎なページ内IDはローカルだけに保持する。参照ブロックには翻訳番号を付けない。
    const numbers = new Map(translateIds.map((id, i) => [id, i + 1]));
    const input = {
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
          system_instruction: system,
          input: JSON.stringify(input),
          response_format: { type: 'text', mime_type: 'application/json', schema: TRANSLATION_SCHEMA },
          generation_config: { max_output_tokens: 65536 },
          stream: true,
          store: false, // Google側に会話を保存しない
        }),
      });
      if (res.ok && /text\/event-stream/i.test(res.headers.get('content-type') || '')) {
        const seen = new Set();
        let unsafe = false;
        const streamed = await readTranslationStream(res, { signal, onItem: (item) => {
          if (unsafe) return;
          if (!validTranslation(item, translateIds.length) || seen.has(item.id)) { unsafe = true; return; }
          seen.add(item.id);
          onTranslation(translateIds[item.id - 1], item.text);
        } });
        signal?.throwIfAborted();
        return parse({ status: streamed.status, steps: [{ type: 'model_output', content: [{ type: 'text', text: streamed.text }] }] }, translateIds);
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) return parse(body, translateIds);
      const err = (Array.isArray(body) ? body[0] : body)?.error || {}; // エラーは [{ error: … }] の形で返ってくる

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
  constructor(message, partial, missing) {
    super(message);
    this.name = 'MissingTranslationsError';
    this.#partial = partial;
    this.#missing = missing;
  }
  get partialTranslations() { return new Map(this.#partial); }
  get missingIds() { return [...this.#missing]; }
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
