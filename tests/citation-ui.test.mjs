import test from "node:test";
import assert from "node:assert/strict";
import { createCitationDialog } from "../citation-ui.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(fileUrl = "https://doi.org/10.1234/paper", overrides = {}) {
  const elements = new Map(),
    copied = [],
    downloads = [],
    calls = [];
  const $ = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: true,
        open: false,
        style: {},
        value: "",
        textContent: "",
        disabled: false,
        classList: { toggle() {} },
        setAttribute() {},
        focus() {},
        addEventListener() {},
        getBoundingClientRect: () => ({ bottom: 60 }),
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
          this.onclose?.();
        },
      });
    return elements.get(id);
  };
  const service = {
    resolve: async (id) => {
      calls.push(id);
      return {
        doi: "10.1234/paper",
        title: "Paper title",
        version: "DOI登録情報",
      };
    },
    formatted: async (_doi, style) => style + " citation",
    exported: async (_doi, format) =>
      format === "bibtex"
        ? "@article{key,\n  title={Paper}\n}"
        : format + " source",
    ...overrides,
  };
  const controller = createCitationDialog({
    document: { querySelector: $ },
    fileUrl,
    getPdf: () => ({}),
    service,
    clipboard: {
      writeText: async (text) => {
        copied.push(text);
      },
    },
    download: (text, filename) => {
      downloads.push({ text, filename });
    },
  });
  return { $, controller, copied, downloads, calls };
}

test("citation panel fetches only on opening and supports three copies and reference exports", async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  await f.controller.open();
  assert.equal(f.$("#citations").open, true);
  assert.equal(f.$("#citations").style.top, "68px");
  assert.equal(f.$("#citationContent").hidden, false);
  const scholar = new URL(f.$("#citationScholar").href);
  assert.equal(scholar.origin, "https://scholar.google.com");
  assert.equal(scholar.searchParams.get("q"), '"Paper title"');
  for (const style of ["mla", "apa", "iso"]) {
    assert.equal(f.$(`#citation-${style}`).textContent, style + " citation");
    await f.$(`#copy-${style}`).onclick();
  }
  assert.deepEqual(f.copied, ["mla citation", "apa citation", "iso citation"]);
  for (const id of ["bibtex", "endnote", "refman", "refworks"]) {
    await f.$(`#export-${id}`).onclick();
    await f.$("#citationExportCopy").onclick();
    f.$("#citationExportSave").onclick();
  }
  assert.deepEqual(
    f.downloads.map((d) => d.filename),
    ["citation.bib", "citation.ris", "citation.ris", "citation.ris"]
  );
  assert.equal(f.downloads[0].text, "@article{key,\n  title={Paper}\n}");
  assert.equal(f.copied[3], f.downloads[0].text);
});

test("unknown PDFs require an identifier, with validation before service calls", async () => {
  const f = fixture("file:///unknown.pdf");
  await f.controller.open();
  assert.equal(f.calls.length, 0);
  assert.equal(f.$("#citationLookup").hidden, false);
  const submit = () => f.$("#citationLookup").onsubmit({ preventDefault() {} });
  f.$("#citationIdentifier").value = "unknown";
  await submit();
  assert.equal(f.calls.length, 0);
  f.$("#citationIdentifier").value = "2301.08243";
  await submit();
  assert.deepEqual(f.calls, [{ type: "arxiv", value: "2301.08243" }]);
  assert.equal(f.$("#citationContent").hidden, false);
});

test("closing a panel prevents late metadata from revealing stale content", async () => {
  const pending = deferred();
  const f = fixture(undefined, { resolve: () => pending.promise });
  const opening = f.controller.open();
  await Promise.resolve();
  f.$("#citationClose").onclick();
  pending.resolve({ doi: "10.1234/paper", title: "late", version: "test" });
  await opening;
  assert.equal(f.$("#citationContent").hidden, true);
});

test("latest export selection wins when responses arrive out of order", async () => {
  const pending = deferred();
  const f = fixture(undefined, {
    exported: async (_doi, format) =>
      format === "bibtex" ? pending.promise : "RIS source",
  });
  await f.controller.open();
  const old = f.$("#export-bibtex").onclick();
  await f.$("#export-endnote").onclick();
  pending.resolve("late BibTeX");
  await old;
  assert.equal(f.$("#citationExportText").value, "RIS source");
  f.$("#citationExportSave").onclick();
  assert.deepEqual(f.downloads, [
    { text: "RIS source", filename: "citation.ris" },
  ]);
});

test("metadata and fast styles appear while a slow style is still pending; completed reopen reuses the panel", async () => {
  const pending = deferred(),
    formats = [];
  const f = fixture(undefined, {
    formatted: async (_doi, style) => {
      formats.push(style);
      return style === "iso" ? pending.promise : style + " early";
    },
  });
  const opening = f.controller.open();
  await new Promise(setImmediate);
  assert.equal(f.$("#citationContent").hidden, false);
  assert.equal(f.$("#citationPaperTitle").textContent, "Paper title");
  assert.equal(f.$("#citation-mla").textContent, "mla early");
  assert.equal(f.$("#copy-mla").disabled, false);
  assert.equal(f.$("#citation-iso").textContent, "取得中…");
  assert.equal(f.$("#copy-iso").disabled, true);
  await f.$("#copy-mla").onclick();
  pending.resolve("iso late");
  await opening;
  assert.equal(f.$("#citationStatus").textContent, "コピーしました");
  assert.equal(f.$("#citation-iso").textContent, "iso late");
  await f.$("#export-bibtex").onclick();
  f.$("#citationClose").onclick();
  await f.controller.open();
  assert.equal(f.calls.length, 1);
  assert.equal(formats.length, 3);
  assert.equal(f.$("#citationExport").hidden, false);
  assert.equal(f.$("#citation-iso").textContent, "iso late");
});

test("closing before metadata resolves does not start formatting requests", async () => {
  const pending = deferred();
  let started = 0;
  const f = fixture(undefined, {
    resolve: () => pending.promise,
    formatted: async () => {
      started++;
      return "unused";
    },
  });
  const opening = f.controller.open();
  await new Promise(setImmediate);
  f.$("#citationClose").onclick();
  pending.resolve({ doi: "10.1234/paper", title: "late", version: "test" });
  await opening;
  assert.equal(started, 0);
});

test("late formats from a previous identifier cannot overwrite a newly selected paper", async () => {
  const pending = deferred();
  const f = fixture(undefined, {
    resolve: async (id) => ({
      doi: id.value,
      title: id.value,
      version: "test",
    }),
    formatted: async (doi, style) =>
      doi === "10.1234/paper" ? pending.promise : style + " new",
  });
  const old = f.controller.open();
  await new Promise(setImmediate);
  f.$("#citationIdentifier").value = "10.1234/new";
  await f.$("#citationLookup").onsubmit({ preventDefault() {} });
  pending.resolve("stale");
  await old;
  assert.equal(f.$("#citationPaperTitle").textContent, "10.1234/new");
  assert.equal(f.$("#citation-mla").textContent, "mla new");
  await f.$("#copy-mla").onclick();
  assert.deepEqual(f.copied, ["mla new"]);
});

test("public identifier prefetch prepares all formats without opening or changing the panel", async () => {
  const formats = [];
  const f = fixture(undefined, {
    formatted: async (doi, style) => {
      formats.push(style);
      return style;
    },
  });
  await Promise.all([f.controller.prefetch(), f.controller.prefetch()]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(formats, ["mla", "apa", "iso"]);
  assert.equal(f.$("#citations").open, false);
  assert.equal(f.$("#citationContent").hidden, true);
});

test("prefetch does not inspect local or unidentified PDF metadata or send it externally", async () => {
  for (const url of ["file:///paper.pdf", "https://example.com/private.pdf"]) {
    const f = fixture(url);
    await f.controller.prefetch();
    assert.equal(f.calls.length, 0);
  }
});
