import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pageContinuations } from "../translation-continuations.js";
import {
  buildKeyedTask,
  taskIssue,
  blockIssue,
} from "../keyed-translations.js";
import {
  createKeyedGeminiTranslator,
  MissingTranslationsError,
} from "../gemini.js";
import { createDocumentTranslator } from "../document-translator.js";
import { planTranslationBatches } from "../translation-batches.js";
import { streamFixture, until } from "./helpers/stream.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/ijepa-page-continuation.json", import.meta.url)
  )
);
const sample = () => structuredClone(fixture);
const options = {
  apiKey: "fixture-key",
  sourceLanguage: "en",
  targetLanguage: "ja",
};
const reply = (output) =>
  Response.json({
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(output) }],
      },
    ],
  });
const pair = () => [
  {
    page: 5,
    blocks: [
      {
        id: "a",
        kind: "paragraph",
        translate: true,
        text: "Prior work [36,22,8]. We match view-",
      },
    ],
  },
  {
    page: 6,
    blocks: [
      {
        id: "b",
        kind: "paragraph",
        translate: true,
        text: "invariant approaches [79]. Another sentence [42].",
      },
    ],
  },
];

test("the reported I-JEPA page break accepts the exact withheld translations without relaxing earlier citations", async () => {
  const { pages, ids, translations } = sample();
  const a = pages[0].blocks[0],
    b = pages[1].blocks.at(-1);
  assert.equal(
    blockIssue(a, translations[0], "English", "Japanese"),
    "citation"
  );
  assert.equal(
    blockIssue(b, translations[1], "English", "Japanese"),
    "citation"
  );
  const task = await buildKeyedTask(pages, ids, "English", "Japanese");
  const keys = [...task.byKey.keys()],
    values = new Map(keys.map((k, i) => [k, translations[i]]));
  assert.equal(pageContinuations(pages).length, 1);
  assert.deepEqual(task.groups.get(keys[0]), keys);
  for (const key of keys)
    assert.equal(taskIssue(task, key, values, "English", "Japanese"), null);
  for (const moved of ["[36]", "[22]", "[8]"]) {
    const wrong = new Map([
      [keys[0], translations[0].replace(moved, "")],
      [keys[1], translations[1] + moved],
    ]);
    for (const key of keys)
      assert.equal(
        taskIssue(task, key, wrong, "English", "Japanese"),
        "citation"
      );
  }
  // Classification evidence is used locally, not sent as new API context.
  assert.ok(
    task.input.pages.every((p) =>
      p.blocks.every((b) => !("translationSkip" in b) && !("translate" in b))
    )
  );
});

test("only the boundary sentence may move citations; missing and repeated markers still fail both fragments", async () => {
  const task = await buildKeyedTask(pair(), ["a", "b"], "English", "Japanese"),
    keys = [...task.byKey.keys()];
  const issue = (a, b) =>
    taskIssue(
      task,
      keys[0],
      new Map([
        [keys[0], a],
        [keys[1], b],
      ]),
      "English",
      "Japanese"
    );
  assert.equal(
    issue("先行研究[36,22,8]、手法[79]に匹敵", "する。別文[42]。"),
    null
  );
  assert.equal(
    issue("先行研究[36,22,8]、手法に匹敵", "する。別文[42]。"),
    "citation"
  );
  assert.equal(
    issue("先行研究[36,22,8]、手法[79]に匹敵", "する[79]。別文[42]。"),
    "citation"
  );
  assert.equal(
    issue("先行研究[36,22,8]、手法[79]に匹敵。別文[42]。", "する。"),
    "citation"
  );
  assert.equal(
    issue("先行研究[36,22]、手法[79]に匹敵", "する[8]。別文[42]。"),
    "citation"
  );
});

test("a boundary-sentence citation can move in either direction while fixed repeated markers remain", async () => {
  const pages = pair();
  pages[0].blocks[0].text =
    "Prior work [8]. We match other methods [8] and view-";
  const task = await buildKeyedTask(pages, ["a", "b"], "English", "Japanese"),
    keys = [...task.byKey.keys()];
  const values = new Map([
    [keys[0], "先行研究[8]。比較する"],
    [keys[1], "手法[8,79]。別の文[42]。"],
  ]);
  assert.equal(taskIssue(task, keys[0], values, "English", "Japanese"), null);
  values.set(keys[0], "先行研究。比較する");
  values.set(keys[1], "手法[8,8,79]。別の文[42]。");
  assert.equal(
    taskIssue(task, keys[0], values, "English", "Japanese"),
    "citation"
  );
});

test("lowercase model names after a sentence stop cannot widen the movable citation region", async () => {
  const pages = pair();
  pages[0].blocks[0].text = "Prior work [36]. iBOT matches view-";
  pages[1].blocks[0].text =
    "invariant approaches [79]. iBOT uses another loss [42].";
  const task = await buildKeyedTask(pages, ["a", "b"], "English", "Japanese"),
    keys = [...task.byKey.keys()];
  const values = new Map([
    [keys[0], "先行研究[36]。手法[79,42]と比較"],
    [keys[1], "する。"],
  ]);
  for (const key of keys)
    assert.equal(
      taskIssue(task, key, values, "English", "Japanese"),
      "citation"
    );
  values.set(keys[0], "先行研究[36]。手法[79]と比較");
  values.set(keys[1], "する。iBOTは別の損失[42]を用いる。");
  for (const key of keys)
    assert.equal(taskIssue(task, key, values, "English", "Japanese"), null);
});

test("page continuation inference never skips unrelated paragraphs, headings or unclassified text", async () => {
  for (const mutate of [
    (p) => {
      p[0].blocks[0].text = "We match view.";
    },
    (p) => {
      p[0].blocks[0].text = "We match view—";
    },
    (p) => {
      p[0].blocks[0].text = "We use 448-";
    },
    (p) => {
      p[1].blocks[0].text = "Invariant methods [79].";
    },
    (p) => {
      p[1].page = 7;
    },
    (p) => {
      p[1].blocks[0].kind = "caption";
    },
    (p) => {
      p[0].blocks[0].mathUncertain = true;
    },
    (p) => {
      p[1].blocks.unshift({
        id: "other",
        kind: "paragraph",
        translate: true,
        text: "Other paragraph.",
      });
    },
    (p) => {
      p[1].blocks.unshift({
        id: "section",
        kind: "heading",
        text: "6. Local Prediction Tasks",
      });
    },
    (p) => {
      p[1].blocks.unshift({
        id: "ref",
        kind: "paragraph",
        translate: false,
        text: "Unclassified reference context.",
      });
    },
    (p) => {
      p[0].blocks.push({ id: "ref", kind: "heading", text: "References" });
    },
  ]) {
    const pages = pair();
    mutate(pages);
    assert.equal(pageContinuations(pages).length, 0);
    const task = await buildKeyedTask(pages, ["a", "b"], "English", "Japanese");
    assert.ok([...task.groups.values()].every((group) => group.length === 1));
  }
  const { pages, ids } = sample();
  // Table rows classified as paragraph must be excluded by layout evidence.
  assert.ok(
    pages[1].blocks.some(
      (b) => b.kind === "paragraph" && b.translationSkip === "table"
    )
  );
  const one = await buildKeyedTask(pages, [ids[1]], "English", "Japanese");
  assert.ok([...one.groups.values()].every((group) => group.length === 1));
  const foreign = await buildKeyedTask(pages, ids, "French", "Japanese");
  assert.ok([...foreign.groups.values()].every((group) => group.length === 1));
});

test("page fragments remain indivisible under target/byte budgets and schema split", async () => {
  const { pages, ids } = sample();
  for (const limits of [{ maxTargets: 1 }, { maxSchemaBytes: 1 }]) {
    const plan = await planTranslationBatches(
      pages,
      ids,
      "English",
      "Japanese",
      null,
      limits
    );
    assert.deepEqual(
      plan.batches.map((b) => b.ids),
      [ids]
    );
    assert.equal(plan.split(plan.batches[0]), null);
  }
});

test("stream previews wait for both page fragments and commit the reported output as one group", async (t) => {
  const { pages, ids, translations } = sample(),
    stream = streamFixture(),
    shown = [];
  let request;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    request = JSON.parse(init.body);
    return stream.response;
  });
  const pending = createKeyedGeminiTranslator({
    ...options,
    batchLimits: { maxTargets: 1 },
  }).translateDocument(pages, ids, (...entry) => shown.push(entry));
  await until(() => !!request);
  const [a, b] = request.response_format.schema.required;
  stream.start();
  stream.text(`{${JSON.stringify(a)}:${JSON.stringify(translations[0])},`);
  await new Promise(setImmediate);
  assert.deepEqual(shown, []);
  stream.text(`${JSON.stringify(b)}:${JSON.stringify(translations[1])}}`);
  await until(() => shown.length === 2);
  stream.complete();
  assert.deepEqual(
    [...(await pending)],
    ids.map((id, i) => [id, translations[i]])
  );
});

test("canceling after one fragment never previews or caches half of the new boundary sentence", async (t) => {
  const pages = pair(),
    rows = pages.map((p) => ({ index: p.page }));
  const stream = streamFixture(),
    controller = new AbortController(),
    commits = [],
    previews = [];
  let request;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    request = JSON.parse(init.body);
    return stream.response;
  });
  const tr = createDocumentTranslator({
    rows,
    getBlocks: (row) => pages.find((p) => p.page === row.index).blocks,
    getCached: (b) => (b.id === "a" ? "以前の訳[36,22,8]" : undefined),
    translator: createKeyedGeminiTranslator({
      ...options,
      signal: controller.signal,
    }),
    signal: controller.signal,
    onCommit: (entries) => commits.push(entries),
    onPreview: (row) => previews.push(tr.previewPage(row)),
  });
  const pending = tr.ready();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await until(() => !!request);
  const a = request.response_format.schema.required[0];
  stream.start();
  stream.text(`{${JSON.stringify(a)}:"新しい訳[36,22,8,79]",`);
  await new Promise(setImmediate);
  controller.abort();
  await rejected;
  assert.equal(stream.cancelled, true);
  assert.equal(tr.completed, false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0][0].text, "以前の訳[36,22,8]");
  assert.equal(previews.length, 1);
  assert.equal(previews[0][0].text, "以前の訳[36,22,8]");
  assert.deepEqual(tr.previewPage(rows[0]), []);
});

test("partial caches, explicit repair and a selected redo always replace both sides of the page break", async (t) => {
  const { pages, ids, translations } = sample(),
    rows = pages.map((p) => ({ index: p.page }));
  const source = (row) => pages.find((p) => p.page === row.index).blocks,
    requests = [],
    committed = [];
  let fail = false;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    const keys = r.response_format.schema.required;
    return reply(
      Object.fromEntries(
        keys.map((k, i) => [
          k,
          fail ? translations[i].replace("[79]", "") : translations[i],
        ])
      )
    );
  });
  const make = (extra = {}) =>
    createDocumentTranslator({
      rows,
      getBlocks: source,
      translator: createKeyedGeminiTranslator(options),
      onCommit: (entries) => committed.push(entries),
      ...extra,
      getCached: (b) =>
        !ids.includes(b.id) ? "表3の説明" : extra.getCached?.(b),
    });
  const cached = make({
    getCached: (b) => (b.id === ids[0] ? "旧訳[36,22,8,79]" : undefined),
  });
  await cached.ready();
  assert.equal(requests[0].response_format.schema.required.length, 2);
  assert.equal(committed.at(-1).length, 2);
  const b = pages[1].blocks.at(-1);
  assert.equal((await cached.retranslateBlocks(b)).size, 2);
  fail = true;
  await assert.rejects(cached.retranslateBlocks(b), MissingTranslationsError);
  const shown = [];
  for (const row of rows)
    await cached.translatePage(row, (_i, text) => shown.push(text));
  assert.equal(shown.at(-1), translations[1]);
  const repair = make();
  await assert.rejects(repair.ready(), MissingTranslationsError);
  assert.equal(repair.missingCount, 2);
  fail = false;
  await repair.repairMissing();
  assert.equal(repair.completed, true);
  assert.equal(repair.missingCount, 0);
  assert.equal(requests.at(-1).response_format.schema.required.length, 2);
  const selected = make();
  const out = await selected.translateSelectedBlocks(b);
  assert.equal(out.size, 2);
  assert.equal(requests.at(-1).response_format.schema.required.length, 2);
});
