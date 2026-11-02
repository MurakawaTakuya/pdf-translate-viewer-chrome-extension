import test from "node:test";
import assert from "node:assert/strict";
import { planTranslationBatches } from "../translation-batches.js";
import {
  createKeyedGeminiTranslator,
  MissingTranslationsError,
  SchemaTooComplexError,
} from "../gemini.js";
import { createDocumentTranslator } from "../document-translator.js";
import { streamFixture, until } from "./helpers/stream.mjs";

const options = {
  apiKey: "fixture-key",
  sourceLanguage: "en",
  targetLanguage: "ja",
  batchLimits: { maxTargets: 2 },
};
const pages = () => [
  {
    page: 1,
    blocks: [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `b${i}`,
        text: `Source paragraph ${i}.`,
        kind: "paragraph",
        translate: true,
      })),
      { id: "ref", text: "Distant reference context.", translate: false },
    ],
  },
];
const ids = (p) =>
  p.flatMap((p) => p.blocks.filter((b) => b.translate).map((b) => b.id));
const targets = (r) =>
  JSON.parse(r.input).pages.flatMap((p) =>
    p.blocks.filter((b) => b.translate_id)
  );
const body = (output) => ({
  status: "completed",
  steps: [
    {
      type: "model_output",
      content: [{ type: "text", text: JSON.stringify(output) }],
    },
  ],
});
const translated = (r) =>
  Object.fromEntries(
    targets(r).map((b) => [
      b.translate_id,
      "訳文 " + (b.text.match(/\[\d+\]/g) || []).join(" "),
    ])
  );

test("batch planning preserves every target and atomic adjacent citation groups", async () => {
  const p = [
    {
      page: 1,
      blocks: [
        { id: "a", text: "A preceding paragraph.", kind: "paragraph" },
        { id: "b", text: "We train for 300,000", kind: "paragraph" },
        {
          id: "c",
          text: "iterations using default settings [13].",
          kind: "paragraph",
        },
        { id: "d", text: "The last paragraph.", kind: "paragraph" },
      ],
    },
  ];
  const plan = await planTranslationBatches(
    p,
    ["a", "b", "c", "d"],
    "English",
    "Japanese",
    null,
    { maxTargets: 2 }
  );
  assert.deepEqual(
    plan.batches.map((b) => b.ids),
    [["a"], ["b", "c"], ["d"]]
  );
  assert.equal(plan.split(plan.batches[1]), null);
  const byteLimited = await planTranslationBatches(
    p,
    ["a", "b", "c", "d"],
    "English",
    "Japanese",
    null,
    { maxTargets: 100, maxSchemaBytes: 1 }
  );
  assert.deepEqual(
    byteLimited.batches.map((b) => b.ids),
    [["a"], ["b", "c"], ["d"]]
  );
  await assert.rejects(
    planTranslationBatches(p, ["a", "a"], "English", "Japanese"),
    /重複/
  );
});

test("batches run sequentially, preview completed blocks, and keep all reference pages", async (t) => {
  const stream = streamFixture(),
    requests = [],
    shown = [],
    progress = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    return requests.length === 1
      ? stream.response
      : Response.json(body(translated(r)));
  });
  const p = pages(),
    pending = createKeyedGeminiTranslator(options).translateDocument(
      p,
      ids(p),
      (...a) => shown.push(a),
      (b) => progress.push(b)
    );
  await until(() => requests.length === 1);
  stream.start();
  stream.text(JSON.stringify(translated(requests[0])));
  await until(() => shown.length === 2);
  assert.equal(requests.length, 1);
  stream.complete();
  const out = await pending;
  assert.equal(out.size, 5);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    progress.filter((b) => !b.translations).map((b) => [b.index, b.total]),
    [
      [1, 3],
      [2, 3],
      [3, 3],
    ]
  );
  for (const r of requests) {
    assert.equal(
      JSON.parse(r.input).pages[0].blocks.at(-1).text,
      p[0].blocks.at(-1).text
    );
    assert.equal(r.model, "gemini-3.5-flash-lite");
  }
  assert.equal(
    new Set(requests.flatMap((r) => targets(r).map((b) => b.translate_id)))
      .size,
    5
  );
});

test("validation failures preserve other batches and explicit repair sends only missing targets", async (t) => {
  const p = pages();
  p[0].blocks[2].text = "This paragraph cites [7].";
  const requests = [],
    progress = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    const value = translated(r);
    if (requests.length === 2) value[targets(r)[0].translate_id] = "引用欠落";
    return Response.json(body(value));
  });
  const row = { index: 1 },
    tr = createDocumentTranslator({
      rows: [row],
      getBlocks: async () => p[0].blocks,
      translator: createKeyedGeminiTranslator(options),
      onProgress: (s) => progress.push(s),
    });
  await assert.rejects(
    tr.ready(),
    (e) =>
      e instanceof MissingTranslationsError &&
      e.partialTranslations.size === 4 &&
      e.missingIds.length === 1
  );
  assert.equal(requests.length, 3);
  assert.equal(tr.missingCount, 1);
  assert.equal(tr.completed, false);
  await tr.repairMissing();
  assert.equal(requests.length, 4);
  assert.equal(targets(requests[3]).length, 1);
  assert.equal(targets(requests[3])[0].text, p[0].blocks[2].text);
  assert.equal(JSON.parse(requests[3].input).pages[0].blocks.length, 6);
  assert.equal(tr.completed, true);
  const shown = [];
  await tr.translatePage(row, (_i, s) => shown.push(s));
  await tr.ready();
  assert.equal(shown.length, 5);
  assert.equal(requests.length, 4);
  assert.ok(progress.some((s) => s.includes("分割2/3")));
});

test("a later request failure retains only fully validated prior batches and does not send later ones", async (t) => {
  let calls = 0;
  const p = pages();
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    return ++calls === 1
      ? Response.json(body(translated(r)))
      : Response.json(
          { error: { message: "Invalid request" } },
          { status: 400 }
        );
  });
  await assert.rejects(
    createKeyedGeminiTranslator(options).translateDocument(p, ids(p)),
    (e) =>
      e instanceof MissingTranslationsError &&
      e.partialTranslations.size === 2 &&
      e.missingIds.join() === "b2,b3,b4" &&
      e.issues.every((i) => i.reason === "request")
  );
  assert.equal(calls, 2);
});

test("only a schema-specific 400 splits further, with a finite split budget", async (t) => {
  const p = pages(),
    requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    return requests.length === 1
      ? Response.json(
          {
            error: {
              message:
                "The specified schema produces a constraint that has too many states for serving.",
            },
          },
          { status: 400 }
        )
      : Response.json(body(translated(r)));
  });
  const result = await createKeyedGeminiTranslator({
    ...options,
    batchLimits: { maxTargets: 10 },
  }).translateDocument(p, ids(p));
  assert.equal(result.size, 5);
  assert.deepEqual(
    requests.map((r) => targets(r).length),
    [5, 3, 2]
  );
  let failures = 0;
  t.mock.method(globalThis, "fetch", async () => {
    failures++;
    return Response.json(
      { error: { message: "The specified schema has too many states" } },
      { status: 400 }
    );
  });
  await assert.rejects(
    createKeyedGeminiTranslator({
      ...options,
      batchLimits: { maxTargets: 10, maxSchemaSplits: 1 },
    }).translateDocument(p, ids(p)),
    SchemaTooComplexError
  );
  assert.equal(failures, 2);
});

test("cancellation between batches makes no further request; empty documents make none", async (t) => {
  const c = new AbortController();
  let calls = 0;
  const p = pages();
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const r = JSON.parse(init.body);
    c.abort();
    return Response.json(body(translated(r)));
  });
  await assert.rejects(
    createKeyedGeminiTranslator({
      ...options,
      signal: c.signal,
    }).translateDocument(p, ids(p)),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
  await createKeyedGeminiTranslator(options).translateDocument(p, []);
  assert.equal(calls, 1);
});

test("a completed batch is checkpointed before cancellation and a new translator resumes only the remainder", async (t) => {
  const p = pages(),
    row = { index: 1 },
    cache = new Map(),
    requests = [],
    controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    if (requests.length === 2) {
      controller.abort();
      throw controller.signal.reason;
    }
    return Response.json(body(translated(r)));
  });
  const settings = {
    rows: [row],
    getBlocks: async () => p[0].blocks,
    getCached: (b) => cache.get(b),
    onCommit: (entries) => {
      for (const { block, text } of entries) cache.set(block, text);
    },
  };
  const first = createDocumentTranslator({
    ...settings,
    signal: controller.signal,
    translator: createKeyedGeminiTranslator({
      ...options,
      signal: controller.signal,
    }),
  });
  await assert.rejects(first.ready(), { name: "AbortError" });
  assert.equal(cache.size, 2);
  assert.equal(first.missingCount, 3);
  const second = createDocumentTranslator({
    ...settings,
    translator: createKeyedGeminiTranslator(options),
  });
  await second.ready();
  assert.equal(second.completed, true);
  assert.equal(cache.size, 5);
  assert.deepEqual(
    requests.slice(2).flatMap((r) => targets(r).map((b) => b.text)),
    p[0].blocks.slice(2, 5).map((b) => b.text)
  );
  const count = requests.length;
  await createDocumentTranslator({
    ...settings,
    translator: createKeyedGeminiTranslator(options),
  }).ready();
  assert.equal(requests.length, count);
});

test("a single request checkpoints verified partial translations without changing its validation diagnostics", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body),
      keys = r.response_format.schema.required;
    return Response.json(
      body({ [keys[0]]: "有効な訳", [keys[1]]: "Abstract" })
    );
  });
  const blocks = [
      { text: "An ordinary paragraph.", translate: true },
      { text: "Abstract", kind: "heading", translate: true },
    ],
    committed = [];
  const tr = createDocumentTranslator({
    rows: [{ index: 1 }],
    getBlocks: async () => blocks,
    onCommit: (entries) => committed.push(...entries),
    translator: createKeyedGeminiTranslator(options),
  });
  await assert.rejects(
    tr.ready(),
    (e) =>
      e instanceof MissingTranslationsError &&
      e.missingIds.length === 1 &&
      /未翻訳1件/.test(e.message)
  );
  assert.equal(committed.length, 1);
  assert.equal(committed[0].text, "有効な訳");
});
