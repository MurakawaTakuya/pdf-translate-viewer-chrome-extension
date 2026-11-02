// Titles come from the original PDF or the existing public citation lookup.
// Never use translated blocks to name a tab.
export function paperTitle(value) {
  if (typeof value !== "string") return null;
  const title = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !title ||
    title.length > 1000 ||
    /^(?:untitled|title|document|paper|main|none|unknown|template|microsoft word(?:\s*-.*)?)$/i.test(
      title
    ) ||
    /\.pdf$/i.test(title) ||
    /^arxiv:\s*\S+$/i.test(title)
  )
    return null;
  return title;
}

export async function pdfPaperTitle(pdf) {
  try {
    const { info = {}, metadata } = await pdf.getMetadata();
    return paperTitle(metadata?.get("dc:title")) || paperTitle(info.Title);
  } catch {
    return null; // Missing metadata must not prevent rendering or translation.
  }
}

export function createPaperTitle({ document, fileUrl, tabId, tabs, label }) {
  let priority = -1;
  function apply(title, rank) {
    if (!title || rank < priority) return;
    priority = rank;
    document.title = title;
    if (label) {
      label.textContent = title;
      label.title = title; // The full title remains available when truncated.
    }
    // A MIME viewer lives in a cross-origin child frame. Set the title of the
    // actual PDF document through our isolated, stream-backed viewer bridge.
    if (Number.isInteger(tabId) && tabs?.sendMessage)
      Promise.resolve()
        .then(() =>
          tabs.sendMessage(
            tabId,
            { type: "setPaperTabTitle", fileUrl, title },
            { frameId: 0 }
          )
        )
        .catch(() => {}); // Older tabs may not have the new content script yet.
  }
  return {
    fallback(name) {
      apply(name, 0);
    },
    async fromPdf(pdf) {
      apply(await pdfPaperTitle(pdf), 2);
    },
    fromCitation(title) {
      apply(paperTitle(title), 1);
    },
  };
}
