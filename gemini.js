// Gemini API（Interactions API）で、ページの段落を数個ずつまとめて翻訳する
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const LANG_NAMES = {
  en: 'English', ja: 'Japanese', zh: 'Simplified Chinese', ko: 'Korean',
  fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian',
};

const systemPrompt = (src, dst) => String.raw`You are a professional translator of academic papers.
The user sends a JSON object whose "paragraphs" array holds text blocks extracted from one page of a PDF paper, in reading order. Translate every block from ${src} into ${dst}.

Rules:
- Translate faithfully into natural, idiomatic language. Preserve all information in the source; do not add explanations, omit details, summarize, or freely paraphrase in ways that change the meaning.
- Preserve negation and its scope, conditions, qualifications, uncertainty, comparisons, causal relationships, and the strength of every claim. Never turn a possibility into a certainty, an association into causation, or a limited claim into a general one.
- If fluency conflicts with fidelity, prioritize fidelity while making the wording as natural as possible. Preserve ambiguity in the source rather than resolving it through guesses or outside knowledge.
- Return exactly one translation per input block, in the same order. Never merge, split, skip, or reorder blocks. A block may be cut off at a column or page break; translate such a fragment as it is, without completing it.
- Write in the formal written style of academic papers in ${dst}.${dst === 'Japanese' ? ' Use the plain "である" style, not "です・ます".' : ''}
- Write every mathematical expression, variable, and symbol as inline LaTeX enclosed in single dollar signs, such as $f_\omega(\cdot)$ or $x_{\text{img}}$, even if the source shows it as broken plain text (e.g. "f ω (·)" or "x img"). Do not use Markdown, and do not use LaTeX outside $...$.
- Keep these unchanged: citation markers such as [12] or (Smith et al., 2020), numbers with units, URLs, code, and names of models, datasets, methods, and acronyms (e.g. BERT, ImageNet, LoRA).
- Use the established technical terms of the field. If a term has no standard translation, keep the original word. Translate the same term the same way throughout the page.
- For section headings and figure/table captions, keep the numbering (e.g. "3.1", "Figure 2:"${dst === 'Japanese' ? ' → "図2:", "Table 1:" → "表1:"' : ''}) and translate concisely.
- The text was extracted from a PDF and may contain broken hyphenation, ligature errors, or stray characters. Fix them silently in the translation.
- Every output string must be written in ${dst}. Never return the ${src} source text unchanged, except for blocks that consist only of names, numbers, or formulas.
- Output only the translations, with no notes or explanations.`;

// 1回のリクエストに入れる量（多すぎると訳さずに原文を返したり、途中で切れたりしやすい）
const MAX_ITEMS = 10;
const MAX_CHARS = 3500;

// 訳文に含まれるはずの文字（これが1文字もなければ「訳されていない」とみなす）
const SCRIPT = { ja: /[\u3040-\u30ff\u4e00-\u9fff]/, zh: /[\u4e00-\u9fff]/, ko: /[\uac00-\ud7af]/ };

const SCHEMA = {
  type: 'object',
  properties: { translations: { type: 'array', items: { type: 'string' } } },
  required: ['translations'],
};

export function createGeminiTranslator({ apiKey, model, sourceLanguage, targetLanguage, onWait = () => {} }) {
  const system = systemPrompt(LANG_NAMES[sourceLanguage] || sourceLanguage, LANG_NAMES[targetLanguage] || targetLanguage);

  async function request(paragraphs, strict = false) {
    const input = { paragraphs };
    if (strict) input.note = `Some of these were previously returned untranslated. Translate every item into ${LANG_NAMES[targetLanguage] || targetLanguage}.`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, // キーはURLに載せない
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          system_instruction: system,
          input: JSON.stringify(input),
          response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA },
          store: false, // Google側に会話を保存しない
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return parse(body, paragraphs.length);
      const err = (Array.isArray(body) ? body[0] : body)?.error || {}; // エラーは [{ error: … }] の形で返ってくる

      // レート制限・一時的なエラーは待って再試行
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const sec = retryDelay(res, err) ?? 5 * 2 ** attempt;
        onWait(`${res.status === 429 ? 'レート制限中' : 'サーバーが混雑中'}… ${Math.ceil(sec)}秒後に再試行します`);
        await new Promise((r) => setTimeout(r, sec * 1000));
        continue;
      }
      throw new Error(describeError(res.status, err));
    }
  }

  // 応答がおかしい（段落数が違う・途中で切れた）ときは、半分ずつに分けて訳し直す
  // 1段落だけでも訳せなかったときは null を返す（その段落は原文のまま表示する。ページ全体は失敗させない）
  async function translateChunk(texts) {
    try {
      return await request(texts);
    } catch (e) {
      if (!(e instanceof BadOutput)) throw e; // 通信エラーなどはそのまま
      if (texts.length === 1) return request(texts).catch((e2) => (e2 instanceof BadOutput ? [null] : Promise.reject(e2)));
      const mid = Math.ceil(texts.length / 2);
      return [...await translateChunk(texts.slice(0, mid)), ...await translateChunk(texts.slice(mid))];
    }
  }

  // 原文をそのまま返してきた段落を見つける
  function untranslated(src, out) {
    if (out == null) return false; // 訳せなかった段落は、念押しの対象にしない
    if ((src.match(/\p{L}{2,}/gu) || []).length < 2) return false; // 名前や数字だけの短い段落は対象外
    const re = SCRIPT[targetLanguage];
    if (re) return !re.test(out);
    const norm = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    return norm(src) === norm(out);
  }

  return {
    // texts を訳し、できたものから onEach(i, 訳文) を呼ぶ（訳せなかった段落は 訳文 = null）。onEach が false を返したら中断
    async translateBatch(texts, onEach) {
      for (const [start, chunk] of chunks(texts)) {
        const out = await translateChunk(chunk);
        // 訳されずに原文のまま返ってきた段落だけ、念押しして訳し直す
        const bad = chunk.map((t, i) => (untranslated(t, out[i]) ? i : -1)).filter((i) => i >= 0);
        if (bad.length) {
          const again = await request(bad.map((i) => chunk[i]), true).catch(() => null);
          if (again) bad.forEach((i, k) => { if (!untranslated(chunk[i], again[k])) out[i] = again[k]; });
        }
        for (let i = 0; i < out.length; i++) if (onEach(start + i, out[i]) === false) return;
      }
    },
  };
}

// [開始位置, 段落の配列] に分ける
function* chunks(texts) {
  let start = 0;
  while (start < texts.length) {
    let end = start, chars = 0;
    while (end < texts.length && end - start < MAX_ITEMS && (end === start || chars + texts[end].length <= MAX_CHARS)) {
      chars += texts[end++].length;
    }
    yield [start, texts.slice(start, end)];
    start = end;
  }
}

class BadOutput extends Error {}

function parse(body, n) {
  if (body.status && body.status !== 'completed') throw new BadOutput(`翻訳が完了しませんでした（${body.status}）`);
  const text = (body.steps || [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  let list;
  try { list = JSON.parse(text).translations; } catch { throw new BadOutput('応答を読み取れませんでした'); }
  if (!Array.isArray(list)) throw new BadOutput('応答を読み取れませんでした');
  // 1段落を頼んだのに、途中で区切って複数に分けて返してきた → つなげて1つの訳にする
  if (n === 1 && list.length > 1) list = [list.join('')];
  if (list.length !== n) throw new BadOutput('段落数が一致しません');
  return list.map(String);
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
