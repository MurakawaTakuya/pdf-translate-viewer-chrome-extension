// Gemini API（Interactions API）で、PDF全文を一括翻訳する
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const DEFAULT_MODEL = 'gemini-3.8-flash';

const LANG_NAMES = {
  en: 'English', ja: 'Japanese', zh: 'Simplified Chinese', ko: 'Korean',
  fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian',
};

const systemPrompt = (src, dst) => String.raw`You are a professional translator of academic papers.
The user sends a JSON object whose "pages" array contains text blocks extracted from every page of a PDF paper, in reading order. Each block has a unique "id" and "text". The "translate_ids" array identifies the blocks to translate from ${src} into ${dst}; all other blocks are reference context only.

Rules:
- Translate faithfully into natural, idiomatic language. Preserve all information in the source; do not add explanations, omit details, summarize, or freely paraphrase in ways that change the meaning.
- Preserve negation and its scope, conditions, qualifications, uncertainty, comparisons, causal relationships, and the strength of every claim. Never turn a possibility into a certainty, an association into causation, or a limited claim into a general one.
- If fluency conflicts with fidelity, prioritize fidelity while making the wording as natural as possible. Preserve ambiguity in the source rather than resolving it through guesses or outside knowledge.
- Read the entire paper for context before translating. Use definitions, abbreviations, and surrounding passages from all pages to interpret each target block accurately.
- Return exactly one object with the unchanged "id" and translated "text" for every ID in "translate_ids". Never merge, split, or skip target blocks, and never translate reference-only blocks. A sentence may continue across blocks or pages: use the neighboring text to understand it, but translate only the content belonging to each block, without duplicating or inventing text.
- Write in the formal written style of academic papers in ${dst}.${dst === 'Japanese' ? ' Use the plain "である" style, not "です・ます".' : ''}
- Write every mathematical expression, variable, and symbol as inline LaTeX enclosed in single dollar signs, such as $f_\omega(\cdot)$ or $x_{\text{img}}$, even if the source shows it as broken plain text (e.g. "f ω (·)" or "x img"). Do not use Markdown, and do not use LaTeX outside $...$.
- Keep these unchanged: citation markers such as [12] or (Smith et al., 2020), numbers with units, URLs, code, and names of models, datasets, methods, and acronyms (e.g. BERT, ImageNet, LoRA).
- Use the established technical terms of the field. If a term has no standard translation, keep the original word. Translate the same term the same way throughout the entire paper.
- For section headings and figure/table captions, keep the numbering (e.g. "3.1", "Figure 2:"${dst === 'Japanese' ? ' → "図2:", "Table 1:" → "表1:"' : ''}) and translate concisely.
- The text was extracted from a PDF and may contain broken hyphenation, ligature errors, or stray characters. Fix them silently in the translation.
- Every translated "text" value must be written in ${dst}; leave all "id" values unchanged. Never return the ${src} source text unchanged, except for blocks that consist only of names, numbers, or formulas.
- Output only the translations, with no notes or explanations.`;

const SCHEMA = {
  type: 'object',
  properties: { translations: {
    type: 'array',
    items: {
      type: 'object',
      properties: { id: { type: 'string' }, text: { type: 'string' } },
      required: ['id', 'text'],
    },
  } },
  required: ['translations'],
};

export function createGeminiTranslator({ apiKey, model, sourceLanguage, targetLanguage, onWait = () => {}, signal }) {
  const system = systemPrompt(LANG_NAMES[sourceLanguage] || sourceLanguage, LANG_NAMES[targetLanguage] || targetLanguage);

  async function translateDocument(pages, translateIds) {
    signal?.throwIfAborted();
    if (!translateIds.length) return new Map();
    const input = { pages, translate_ids: translateIds };
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, // キーはURLに載せない
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          system_instruction: system,
          input: JSON.stringify(input),
          response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA },
          generation_config: { max_output_tokens: 65536 },
          store: false, // Google側に会話を保存しない
        }),
      });
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

function parse(body, ids) {
  if (body.status === 'incomplete') throw new BadOutput('全文の翻訳が途中で切れました（出力上限など）。完了した翻訳としては表示しません');
  if (body.status && body.status !== 'completed') throw new BadOutput(`翻訳が完了しませんでした（${body.status}）`);
  const text = (body.steps || [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  let list;
  try { list = JSON.parse(text).translations; } catch { throw new BadOutput('応答を読み取れませんでした'); }
  const invalid = () => new BadOutput('全文の翻訳に抜け・重複・空の訳文があります。もう一度「翻訳開始」を押してください');
  if (!Array.isArray(list) || list.length !== ids.length) throw invalid();
  const expected = new Set(ids), out = new Map();
  for (const item of list) {
    if (!item || !expected.has(item.id) || out.has(item.id) || typeof item.text !== 'string' || !item.text.trim()) throw invalid();
    out.set(item.id, item.text);
  }
  return out;
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
