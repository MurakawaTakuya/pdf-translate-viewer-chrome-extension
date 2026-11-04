// 翻訳は1つの処理として共有する。大きい文書では対象を分割して送る。
import { MissingTranslationsError } from "./gemini.js";

export function createDocumentTranslator({
  rows,
  translator,
  getBlocks,
  getCached = () => undefined,
  onCommit = () => {},
  onProgress = () => {},
  onPreview = () => {},
  onResetPreview = () => {},
  signal,
}) {
  let documentPromise, translationPromise;
  let missingIds = [],
    repairing = false;
  let issues = [];
  const partial = new Map();
  const idsByBlock = new Map();
  const blocksById = new Map();
  const targetsByRow = new Map();
  const rowsById = new Map(),
    preview = new Map();
  let completed = false;
  let originalCount = 0;

  function prepare() {
    return (documentPromise ??= (async () => {
      const pages = [],
        ids = [];
      for (const r of rows) {
        signal?.throwIfAborted();
        onProgress(`全文を読み取り中… ${r.index}/${rows.length}ページ`);
        const blocks = await getBlocks(r);
        signal?.throwIfAborted();
        const targets = [];
        pages.push({
          page: r.index,
          blocks: blocks.map((b, i) => {
            const id = `p${r.index}-b${i}`;
            idsByBlock.set(b, id);
            blocksById.set(id, b);
            rowsById.set(id, r);
            const cached = getCached(b);
            if (b.translate && typeof cached === "string") {
              partial.set(id, cached);
              preview.set(id, cached);
            }
            if (b.translate) {
              ids.push(id);
              targets.push(b);
            }
            return {
              id,
              kind: b.kind || "paragraph",
              text: b.text,
              translate: !!b.translate,
              ...(b.translationSkip
                ? { translationSkip: b.translationSkip }
                : {}),
              ...(b.mathSpans?.length ? { mathSpans: b.mathSpans } : {}),
              ...(b.mathUncertain ? { mathUncertain: true } : {}),
            };
          }),
        });
        targetsByRow.set(r, targets);
        const cached = targets
          .filter((b) => partial.has(idsByBlock.get(b)))
          .map((block) => ({
            block,
            row: r,
            text: partial.get(idsByBlock.get(block)),
          }));
        if (cached.length) {
          onCommit(cached);
          onPreview(r);
        }
      }
      return { pages, ids };
    })());
  }

  function ready() {
    // 失敗したPromiseも保持する。スクロールや保存では再送せず、明示的な再試行を待つ。
    return (translationPromise ??= prepare()
      .then(async ({ pages, ids }) => {
        signal?.throwIfAborted();
        onProgress(`全文をGeminiで翻訳中…（${ids.length}段落）`);
        const result = await streamDocument(
          pages,
          ids.filter((id) => !partial.has(id))
        );
        for (const [id, text] of result) partial.set(id, text);
        originalCount = [...partial.values()].filter((v) => v === null).length;
        return partial;
      })
      .catch(rememberMissing));
  }

  async function streamDocument(pages, ids) {
    completed = false;
    if (ids.length && translator.expandTargets) {
      const { ids: allIds } = await prepare();
      ids = await translator.expandTargets(pages, allIds, ids);
      signal?.throwIfAborted();
    }
    let batchLabel = "";
    const shown = () =>
      ids.reduce((count, id) => count + Number(preview.has(id)), 0);
    const result = await translator.translateDocument(
      pages,
      ids,
      (id, text) => {
        signal?.throwIfAborted();
        preview.set(id, text);
        onProgress(`Geminiで翻訳中…${batchLabel} ${shown()}/${ids.length}段落`);
        onPreview(rowsById.get(id));
      },
      (batch) => {
        if (batch.translations) {
          const committed = [];
          for (const [id, text] of batch.translations) {
            partial.set(id, text);
            committed.push({
              block: blocksById.get(id),
              row: rowsById.get(id),
              text,
            });
          }
          onCommit(committed);
          return;
        }
        batchLabel =
          batch.total > 1 ? `（分割${batch.index}/${batch.total}）` : "";
        onProgress(`Geminiで翻訳中…${batchLabel} ${shown()}/${ids.length}段落`);
      }
    );
    signal?.throwIfAborted();
    completed = true;
    originalCount = [...result.values()].filter(
      (value) => value === null
    ).length;
    preview.clear();
    return result;
  }

  function rememberMissing(error) {
    preview.clear();
    onResetPreview();
    if (error instanceof MissingTranslationsError) {
      for (const [id, text] of error.partialTranslations) partial.set(id, text);
      missingIds = error.missingIds;
      originalCount = [...partial.values()].filter(
        (value) => value === null
      ).length;
      const details = new Map(error.issues.map((issue) => [issue.id, issue]));
      issues = missingIds.map((id) => ({
        id,
        reason: "missing",
        source: blocksById.get(id)?.text || "",
        ...details.get(id),
        page: rowsById.get(id)?.index,
        block:
          (targetsByRow.get(rowsById.get(id)) || []).indexOf(
            blocksById.get(id)
          ) + 1,
      }));
    } else if (error?.name === "AbortError" && partial.size) {
      missingIds = [...blocksById]
        .filter(([id, b]) => b.translate && !partial.has(id))
        .map(([id]) => id);
    }
    throw error;
  }

  function repairMissing() {
    // 追加リクエストは明示的な操作だけ。連打でも同じPromiseを共有する。
    if (!missingIds.length || repairing) return ready();
    repairing = true;
    completed = false;
    const repairIds = [...missingIds];
    translationPromise = prepare()
      .then(async ({ pages }) => {
        signal?.throwIfAborted();
        onProgress(`不足${repairIds.length}段落だけ再翻訳中…`);
        const result = await streamDocument(pages, repairIds);
        signal?.throwIfAborted();
        for (const [id, text] of result) partial.set(id, text);
        originalCount = [...partial.values()].filter(
          (value) => value === null
        ).length;
        missingIds = [];
        issues = [];
        return partial;
      })
      .catch(rememberMissing)
      .finally(() => {
        repairing = false;
      });
    return translationPromise;
  }

  async function retranslateBlocks(b) {
    const out = await ready();
    const { pages, ids } = await prepare();
    signal?.throwIfAborted();
    const id = idsByBlock.get(b);
    if (!id) throw new Error("翻訳対象の段落が見つかりません");
    const related = translator.relatedTargets
      ? await translator.relatedTargets(pages, ids, id)
      : [id];
    signal?.throwIfAborted();
    // A shared sentence's citations must be replaced atomically, never one fragment alone.
    const result = await translator.translateDocument(pages, related);
    signal?.throwIfAborted();
    for (const [key, text] of result) out.set(key, text);
    onCommit(
      [...result].map(([id, text]) => ({
        block: blocksById.get(id),
        row: rowsById.get(id),
        text,
      }))
    );
    return new Map(
      [...result].map(([key, text]) => [blocksById.get(key), text])
    );
  }

  // Read reference context without ready(): only the selected block's citation
  // group is an output target, never the remaining document.
  async function translateSelectedBlocks(
    b,
    onTargets = () => {},
    { force = false } = {}
  ) {
    const { pages, ids } = await prepare();
    signal?.throwIfAborted();
    const id = idsByBlock.get(b);
    if (!id || !ids.includes(id))
      throw new Error("このブロックは翻訳対象ではありません");
    const related = translator.relatedTargets
      ? await translator.relatedTargets(pages, ids, id)
      : [id];
    signal?.throwIfAborted();
    onTargets(related.map((id) => blocksById.get(id)));
    const result =
      !force && related.every((id) => partial.has(id))
        ? new Map(related.map((id) => [id, partial.get(id)]))
        : await translator.translateDocument(pages, related);
    signal?.throwIfAborted();
    return new Map([...result].map(([id, text]) => [blocksById.get(id), text]));
  }

  return {
    ready,
    repairMissing,
    retranslateBlocks,
    translateSelectedBlocks,
    get completed() {
      return completed;
    },
    get originalCount() {
      return originalCount;
    },
    previewPage(r) {
      return (targetsByRow.get(r) || []).flatMap((block) => {
        const id = idsByBlock.get(block);
        return preview.has(id) ? [{ block, text: preview.get(id) }] : [];
      });
    },
    get missingCount() {
      return missingIds.length;
    },
    get issues() {
      return issues.map((issue) => ({ ...issue }));
    },
    async translatePage(r, onEach) {
      const out = await ready();
      signal?.throwIfAborted();
      const targets = targetsByRow.get(r);
      for (let i = 0; i < targets.length; i++) {
        const text = out.get(idsByBlock.get(targets[i]));
        if (
          (text === null
            ? onEach(i, null, { original: true })
            : onEach(i, text)) === false
        )
          return;
      }
    },
    async retranslateBlock(b) {
      return (await retranslateBlocks(b)).get(b);
    },
  };
}
