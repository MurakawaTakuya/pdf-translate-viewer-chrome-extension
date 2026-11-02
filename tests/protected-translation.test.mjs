import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProtectedTask,
  protectedPrompt,
  createProtectedGeminiTranslator,
} from "../protected-translator.js";
import { MissingTranslationsError } from "../gemini.js";
import { createDocumentTranslator } from "../document-translator.js";
import { taskIssue } from "../keyed-translations.js";
import {
  protectedRuns,
  mathImage,
  ensureMathImages,
} from "../protected-spans.js";
import { streamFixture, until } from "./helpers/stream.mjs";

const text = "A vector sx uses a model [4,5] and prior work [18].";
const pages = () => [
  {
    page: 1,
    blocks: [
      {
        id: "a",
        kind: "paragraph",
        text,
        mathSpans: [
          {
            start: 9,
            end: 11,
            text: "sx",
            x0: 10,
            x1: 22,
            top: 10,
            bottom: 23,
            base: 20,
            h: 10,
          },
        ],
      },
      { id: "b", kind: "heading", text: "Abstract" },
    ],
  },
];
const options = {
  apiKey: "mock-key",
  sourceLanguage: "en",
  targetLanguage: "ja",
};
const response = (value) =>
  Response.json({
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(value) }],
      },
    ],
  });

test("protected source tags restore exact references while original math remains an opaque local glyph span", async () => {
  const source = pages(),
    task = await buildProtectedTask(source, ["a", "b"], "English", "Japanese");
  const [key] = task.byKey.keys(),
    block = task.input.pages[0].blocks[0];
  const math = block.protected_spans.find((s) => s.kind === "math");
  const refs = block.protected_spans.filter((s) => s.kind === "citation");
  assert.equal(refs[0].source, "[4,5]");
  assert.equal(refs[1].source, "[18]");
  const translated = `先行研究${refs[1].tag}を使うベクトル${math.tag}とモデル${refs[0].tag}`;
  assert.equal(
    taskIssue(task, key, new Map([[key, translated]]), "English", "Japanese"),
    null
  );
  const display = task.displayText(key, translated);
  assert.match(display, /先行研究\[18\]/);
  assert.ok(display.includes(math.tag));
  const runs = protectedRuns(display, source[0].blocks[0].mathSpans);
  assert.equal(runs.filter((r) => r.math).length, 1);
  assert.equal(runs.find((r) => r.math).math.text, "sx");
});

test("missing, duplicate, foreign, cross-block or damaged protection tags and generated LaTeX are rejected", async () => {
  const task = await buildProtectedTask(
    pages(),
    ["a", "b"],
    "English",
    "Japanese"
  );
  const [key, other] = task.byKey.keys();
  const tags = task.input.pages[0].blocks[0].protected_spans.map((s) => s.tag);
  for (const value of [
    tags.slice(1).join(""),
    tags.join("") + tags[0],
    tags.join("") + "<m_deadbeef/>",
    tags.join("").replace("/>", ",m_bad/>"),
    tags.join("") + "$x$",
    tags.join("") + "\u0008oldsymbol",
    tags.join("") + " α + β = 0",
    tags.join("") + "<M_ABCD/>",
    tags.join("") + "<math>y=3</math>",
  ]) {
    assert.ok(
      ["protected", "math"].includes(
        taskIssue(task, key, new Map([[key, value]]), "English", "Japanese")
      )
    );
  }
  assert.equal(
    taskIssue(task, other, new Map([[other, tags[0]]]), "English", "Japanese"),
    "protected"
  );
});

test("the protected prompt removes the instruction to reconstruct extracted formulas", () => {
  const prompt = protectedPrompt(
    "- Write every mathematical expression as inline LaTeX.\n- The text was extracted from a PDF; fix silently.",
    "English",
    "Japanese"
  );
  assert.ok(!prompt.includes("as inline LaTeX"));
  assert.match(prompt, /Never emit LaTeX/);
  assert.match(prompt, /less\/fewer means a smaller amount, not none/);
});

test("original math images use source glyph coordinates and can survive release of the page canvas", () => {
  const draws = [],
    canvas = {
      getContext: () => ({ drawImage: (...args) => draws.push(args) }),
      toDataURL: () => "data:image/png;base64,fixture",
    };
  const span = { x0: 10, x1: 22, top: 10, bottom: 23 };
  const row = { srcCanvas: {}, scale: 2 };
  const url = mathImage(row, span, { createElement: () => canvas });
  assert.deepEqual(draws[0].slice(1), [20, 20, 24, 26, 0, 0, 24, 26]);
  assert.equal(canvas.width, 0);
  assert.equal(mathImage({ srcCanvas: null, scale: 0 }, span, {}), url);
});

test("saving refreshes low-zoom math crops at a fixed density without changing the visible page", async () => {
  const rendered = [],
    canvases = [];
  const document = {
    createElement() {
      const canvas = {
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => "data:image/png;base64,export",
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  const span = {
    x0: 10,
    x1: 22,
    top: 10,
    bottom: 23,
    imageUrl: "tiny",
    imageScale: 0.15,
  };
  const row = {
    scale: 0.15,
    vp: { width: 612, height: 792, scale: 1 },
    page: {
      render: (options) => {
        rendered.push(options);
        return { promise: Promise.resolve() };
      },
    },
  };
  await ensureMathImages(row, [span], document);
  assert.equal(span.imageScale, 3);
  assert.equal(row.scale, 0.15);
  assert.equal(rendered[0].transform[0], 3);
  assert.ok(canvases.every((c) => c.width === 0 && c.height === 0));
  await ensureMathImages(row, [span], document);
  assert.equal(rendered.length, 1);
});

test("the real client withholds invalid tags during streaming and retains only validated results", async (t) => {
  const stream = streamFixture();
  let request;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    request = JSON.parse(init.body);
    return stream.response;
  });
  const shown = [],
    source = pages();
  const pending = createProtectedGeminiTranslator(options).translateDocument(
    source,
    ["a", "b"],
    (...item) => shown.push(item)
  );
  const failed = assert.rejects(pending, (error) => {
    assert.ok(error instanceof MissingTranslationsError);
    assert.deepEqual(error.missingIds, ["a"]);
    assert.deepEqual([...error.partialTranslations], [["b", "要旨"]]);
    assert.equal(error.issues[0].reason, "protected");
    return true;
  });
  await until(() => !!request);
  const [a, b] = request.response_format.schema.required;
  stream.start();
  stream.text(JSON.stringify({ [a]: "目印を落とした訳", [b]: "要旨" }));
  stream.complete();
  await failed;
  assert.deepEqual(shown, [["b", "要旨"]]);
});

test("uncertain mixed glyph runs remain original and are excluded from generated targets, with full context retained", async (t) => {
  const source = pages();
  source[0].blocks[0].mathUncertain = true;
  let input;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const request = JSON.parse(init.body);
    input = JSON.parse(request.input);
    return response({ [request.response_format.schema.required[0]]: "要旨" });
  });
  const out = await createProtectedGeminiTranslator(options).translateDocument(
    source,
    ["a", "b"]
  );
  assert.equal(out.get("a"), null);
  assert.equal(out.get("b"), "要旨");
  assert.equal(input.pages[0].blocks.length, 2);
  assert.equal(input.pages[0].blocks[0].translate_id, undefined);
  assert.equal(input.pages[0].blocks[0].protected_spans.length, 3);
});

test("document orchestration keeps original math geometry and counts retained original blocks", async (t) => {
  const source = pages()[0].blocks;
  source[0].mathUncertain = true;
  source.forEach((block) => {
    block.translate = true;
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const request = JSON.parse(init.body);
    return response({ [request.response_format.schema.required[0]]: "要旨" });
  });
  const rows = [{ index: 1 }],
    translator = createDocumentTranslator({
      rows,
      getBlocks: async () => source,
      translator: createProtectedGeminiTranslator(options),
    });
  await translator.ready();
  assert.equal(translator.originalCount, 1);
  const shown = [];
  await translator.translatePage(rows[0], (...args) => shown.push(args));
  assert.equal(shown[0][1], null);
  assert.deepEqual(shown[0][2], { original: true });
  assert.equal(shown[1][1], "要旨");
});
