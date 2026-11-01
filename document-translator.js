// 全文の翻訳は1回だけ行い、画面表示・スクロール・PDF保存で同じ結果を共有する。
import { MissingTranslationsError } from './gemini.js';

export function createDocumentTranslator({ rows, translator, getBlocks, onProgress = () => {}, onPreview = () => {}, onResetPreview = () => {}, signal }) {
  let documentPromise, translationPromise;
  let missingIds = [], repairing = false;
  let issues = [];
  const partial = new Map();
  const idsByBlock = new Map();
  const blocksById = new Map();
  const targetsByRow = new Map();
  const rowsById = new Map(), preview = new Map();
  let completed = false;
  let originalCount = 0;

  function prepare() {
    return documentPromise ??= (async () => {
      const pages = [], ids = [];
      for (const r of rows) {
        signal?.throwIfAborted();
        onProgress(`全文を読み取り中… ${r.index}/${rows.length}ページ`);
        const blocks = await getBlocks(r);
        signal?.throwIfAborted();
        const targets = [];
        pages.push({ page: r.index, blocks: blocks.map((b, i) => {
          const id = `p${r.index}-b${i}`;
          idsByBlock.set(b, id);
          blocksById.set(id, b);
          rowsById.set(id, r);
          if (b.translate) { ids.push(id); targets.push(b); }
          return { id, kind: b.kind || 'paragraph', text: b.text,
            ...(b.mathSpans?.length ? { mathSpans: b.mathSpans } : {}),
            ...(b.mathUncertain ? { mathUncertain: true } : {}),
          };
        }) });
        targetsByRow.set(r, targets);
      }
      return { pages, ids };
    })();
  }

  function ready() {
    // 失敗したPromiseも保持する。スクロールや保存では再送せず、明示的な再試行を待つ。
    return translationPromise ??= prepare().then(({ pages, ids }) => {
      signal?.throwIfAborted();
      onProgress(`全文をGeminiで翻訳中…（${ids.length}段落）`);
      return streamDocument(pages, ids);
    }).catch(rememberMissing);
  }

  async function streamDocument(pages, ids) {
    completed = false;
    const result = await translator.translateDocument(pages, ids, (id, text) => {
      signal?.throwIfAborted();
      preview.set(id, text);
      onProgress(`Geminiで翻訳中… ${preview.size}/${ids.length}段落`);
      onPreview(rowsById.get(id));
    });
    signal?.throwIfAborted();
    completed = true;
    originalCount = [...result.values()].filter((value) => value === null).length;
    preview.clear();
    return result;
  }

  function rememberMissing(error) {
    preview.clear();
    onResetPreview();
    if (error instanceof MissingTranslationsError) {
      for (const [id, text] of error.partialTranslations) partial.set(id, text);
      missingIds = error.missingIds;
      originalCount = [...partial.values()].filter((value) => value === null).length;
      const details = new Map(error.issues.map((issue) => [issue.id, issue]));
      issues = missingIds.map((id) => ({
        id, reason: 'missing', source: blocksById.get(id)?.text || '', ...details.get(id),
        page: rowsById.get(id)?.index,
        block: (targetsByRow.get(rowsById.get(id)) || []).indexOf(blocksById.get(id)) + 1,
      }));
    }
    throw error;
  }

  function repairMissing() {
    // 追加リクエストは明示的な操作だけ。連打でも同じPromiseを共有する。
    if (!missingIds.length || repairing) return ready();
    repairing = true;
    completed = false;
    const repairIds = [...missingIds];
    translationPromise = prepare().then(async ({ pages }) => {
      signal?.throwIfAborted();
      onProgress(`不足${repairIds.length}段落だけ再翻訳中…`);
      const result = await streamDocument(pages, repairIds);
      signal?.throwIfAborted();
      for (const [id, text] of result) partial.set(id, text);
      originalCount = [...partial.values()].filter((value) => value === null).length;
      missingIds = [];
      issues = [];
      return partial;
    }).catch(rememberMissing).finally(() => { repairing = false; });
    return translationPromise;
  }

  async function retranslateBlocks(b) {
    const out = await ready();
    const { pages, ids } = await prepare();
    signal?.throwIfAborted();
    const id = idsByBlock.get(b);
    if (!id) throw new Error('翻訳対象の段落が見つかりません');
    const related = translator.relatedTargets ? await translator.relatedTargets(pages, ids, id) : [id];
    signal?.throwIfAborted();
    // A shared sentence's citations must be replaced atomically, never one fragment alone.
    const result = await translator.translateDocument(pages, related);
    signal?.throwIfAborted();
    for (const [key, text] of result) out.set(key, text);
    return new Map([...result].map(([key, text]) => [blocksById.get(key), text]));
  }

  return {
    ready,
    repairMissing,
    retranslateBlocks,
    get completed() { return completed; },
    get originalCount() { return originalCount; },
    previewPage(r) {
      return (targetsByRow.get(r) || []).flatMap((block) => {
        const id = idsByBlock.get(block);
        return preview.has(id) ? [{ block, text: preview.get(id) }] : [];
      });
    },
    get missingCount() { return missingIds.length; },
    get issues() { return issues.map((issue) => ({ ...issue })); },
    async translatePage(r, onEach) {
      const out = await ready();
      signal?.throwIfAborted();
      const targets = targetsByRow.get(r);
      for (let i = 0; i < targets.length; i++) {
        const text = out.get(idsByBlock.get(targets[i]));
        if ((text === null ? onEach(i, null, { original: true }) : onEach(i, text)) === false) return;
      }
    },
    async retranslateBlock(b) {
      return (await retranslateBlocks(b)).get(b);
    },
  };
}
