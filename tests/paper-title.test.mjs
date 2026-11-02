import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { paperTitle, pdfPaperTitle, createPaperTitle } from "../paper-title.js";

test("PDF titles normalize whitespace, prefer XMP and ignore placeholder metadata", async () => {
  assert.equal(paperTitle(" A\n  Paper\u0000Title "), "A Paper Title");
  for (const value of [
    null,
    {},
    "",
    "Untitled",
    "main.pdf",
    "Microsoft Word - paper.docx",
    "arXiv:2301.08243",
  ])
    assert.equal(paperTitle(value), null);
  assert.equal(
    await pdfPaperTitle({
      getMetadata: async () => ({
        info: { Title: "Info title" },
        metadata: { get: () => "XMP title" },
      }),
    }),
    "XMP title"
  );
  assert.equal(
    await pdfPaperTitle({
      getMetadata: async () => ({
        info: { Title: "Info title" },
        metadata: { get: () => "Untitled" },
      }),
    }),
    "Info title"
  );
  assert.equal(
    await pdfPaperTitle({
      getMetadata: async () => {
        throw new Error("unavailable");
      },
    }),
    null
  );
});

test("metadata wins over early or late citations and only the matching MIME tab is addressed", async () => {
  const document = {},
    calls = [];
  const title = createPaperTitle({
    document,
    fileUrl: "https://example.org/p.pdf",
    tabId: 42,
    tabs: { sendMessage: async (...args) => calls.push(args) },
  });
  title.fallback("p.pdf - PDF翻訳ビューア");
  title.fromCitation("Original citation title");
  await title.fromPdf({
    getMetadata: async () => ({ info: { Title: "Original PDF title" } }),
  });
  title.fromCitation("Late citation title");
  await new Promise(setImmediate);
  assert.equal(document.title, "Original PDF title");
  assert.deepEqual(
    calls.map((c) => [c[0], c[1].title, c[2]]),
    [
      [42, "p.pdf - PDF翻訳ビューア", { frameId: 0 }],
      [42, "Original citation title", { frameId: 0 }],
      [42, "Original PDF title", { frameId: 0 }],
    ]
  );
  assert.ok(calls.every((c) => c[1].fileUrl === "https://example.org/p.pdf"));
});

test("a failed MIME bridge does not break a legacy title or overwrite the download filename", async () => {
  const document = {};
  const title = createPaperTitle({
    document,
    fileUrl: "file:///paper.pdf",
    tabId: 42,
    tabs: {
      sendMessage: () => {
        throw new Error("tab closed");
      },
    },
  });
  title.fallback("paper.pdf - PDF翻訳ビューア");
  await title.fromPdf({});
  assert.equal(document.title, "paper.pdf - PDF翻訳ビューア");
  title.fromCitation("Recovered original title");
  await new Promise(setImmediate);
  assert.equal(document.title, "Recovered original title");
  const standalone = {};
  createPaperTitle({ document: standalone }).fromCitation("Standalone title");
  assert.equal(standalone.title, "Standalone title");
});

const contentScript = await readFile(
  new URL("../paper-title-content.js", import.meta.url),
  "utf8"
);
function contentFixture({
  contentType = "application/pdf",
  url = "https://arxiv.org/pdf/2301.08243#page=3",
  embedded = false,
} = {}) {
  const document = { contentType, title: "before" };
  const window = {};
  window.top = embedded ? {} : window;
  let listener;
  const viewer = "chrome-extension://ours/viewer.html";
  vm.runInNewContext(contentScript, {
    document,
    window,
    location: { href: url },
    URL,
    chrome: {
      runtime: {
        id: "ours",
        getURL: () => viewer,
        onMessage: {
          addListener: (callback) => {
            listener = callback;
          },
        },
      },
    },
  });
  return {
    document,
    send(message = {}, sender = {}) {
      let reply;
      listener(
        {
          type: "setPaperTabTitle",
          fileUrl: url.split("#")[0],
          title: "Original paper title",
          ...message,
        },
        { id: "ours", url: viewer, ...sender },
        (value) => {
          reply = value;
        }
      );
      return reply;
    },
  };
}

test("the content script changes the actual PDF title without changing its URL", () => {
  const f = contentFixture();
  assert.equal(f.send().ok, true);
  assert.equal(f.document.title, "Original paper title");
  const local = contentFixture({ url: "file:///papers/test.pdf" });
  assert.equal(local.send().ok, true);
  const wrapper = contentFixture({ contentType: "text/html" });
  assert.equal(wrapper.send().ok, true);
});

test("child frames, unrelated PDFs and ordinary page or foreign senders cannot be renamed", () => {
  for (const options of [{ embedded: true }]) {
    const f = contentFixture(options);
    assert.equal(f.send(), undefined);
    assert.equal(f.document.title, "before");
  }
  for (const [message, sender] of [
    [{ fileUrl: "https://arxiv.org/pdf/other" }, {}],
    [{ fileUrl: "javascript:alert(1)" }, {}],
    [{ title: " " }, {}],
    [{ title: "x".repeat(1001) }, {}],
    [{}, { id: "other" }],
    [{}, { url: "https://arxiv.org/pdf/2301.08243" }],
    [{}, { url: "chrome-extension://ours/popup.html" }],
  ]) {
    const f = contentFixture();
    assert.equal(f.send(message, sender), undefined);
    assert.equal(f.document.title, "before");
  }
});
