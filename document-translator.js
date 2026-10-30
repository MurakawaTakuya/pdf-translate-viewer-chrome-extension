// 全文の翻訳は1回だけ行い、画面表示・スクロール・PDF保存で同じ結果を共有する。
export function createDocumentTranslator({ rows, translator, getBlocks, onProgress = () => {}, signal }) {
  let documentPromise, translationPromise;
  const idsByBlock = new Map();
  const targetsByRow = new Map();

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
          if (b.translate) { ids.push(id); targets.push(b); }
          return { id, text: b.text };
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
      return translator.translateDocument(pages, ids);
    });
  }

  return {
    ready,
    async translatePage(r, onEach) {
      const out = await ready();
      signal?.throwIfAborted();
      const targets = targetsByRow.get(r);
      for (let i = 0; i < targets.length; i++) {
        if (onEach(i, out.get(idsByBlock.get(targets[i]))) === false) return;
      }
    },
    async retranslateBlock(b) {
      const out = await ready();
      const { pages } = await prepare();
      signal?.throwIfAborted();
      const id = idsByBlock.get(b);
      if (!id) throw new Error('翻訳対象の段落が見つかりません');
      // 手動の訳し直しでも、参照用に全文を渡す。
      const result = await translator.translateDocument(pages, [id]);
      signal?.throwIfAborted();
      out.set(id, result.get(id));
      return result.get(id);
    },
  };
}
