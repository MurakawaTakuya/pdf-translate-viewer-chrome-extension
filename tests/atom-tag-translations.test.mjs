import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAtomTagTask,
  createAtomTagGeminiTranslator,
} from "../atom-tag-translations.js";
import { MissingTranslationsError } from "../gemini.js";
import { streamFixture, until } from "./helpers/stream.mjs";
const options = {
  apiKey: "fixture",
  sourceLanguage: "en",
  targetLanguage: "ja",
};
const pages = () => [
  {
    page: 1,
    blocks: [
      {
        id: "a",
        kind: "paragraph",
        text: "The model RN152 is used following prior work [4].",
      },
      { id: "b", kind: "heading", text: "Abstract" },
    ],
  },
  {
    page: 2,
    blocks: [{ id: "ref", text: "This other page is reference context." }],
  },
];
const body = (text) => ({
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text }] }],
});

test("plain string tags bind originals to their own block and support Japanese reordering", async () => {
  const task = await buildAtomTagTask(
      pages(),
      ["a", "b"],
      "English",
      "Japanese"
    ),
    [key, other] = task.byKey.keys();
  const [model, ref] = task.input.pages[0].blocks[0].original_atoms.map(
    (a) => a.tag
  );
  const value = `先行研究${ref}に従いモデル${model}を使う。`;
  assert.equal(
    task
      .parse(body(JSON.stringify({ [key]: value, [other]: "概要" })))
      .get("a"),
    "先行研究[4]に従いモデルRN152を使う。"
  );
  assert.equal(task.schema.required.length, 2);
  assert.ok(
    Object.values(task.schema.properties).every((p) => p.type === "string")
  );
  assert.deepEqual(task.input.pages[1].blocks, [
    { text: pages()[1].blocks[0].text },
  ]);
  assert.doesNotMatch(task.input.pages[0].blocks[0].text, /RN152|\[4\]/);
});

test("omitted, duplicate, foreign and copied original atoms remain withheld", async () => {
  const task = await buildAtomTagTask(
      pages(),
      ["a", "b"],
      "English",
      "Japanese"
    ),
    [key, other] = task.byKey.keys(),
    [model, ref] = task.input.pages[0].blocks[0].original_atoms.map(
      (a) => a.tag
    );
  for (const value of [
    `モデル${model}を使う。`,
    `モデル${model}${model}、先行研究${ref}。`,
    `モデル${model}、先行研究<n_dead/>。`,
    `モデルRN152${model}、先行研究${ref}。`,
    `モデル${model}、先行研究[4]${ref}。`,
  ]) {
    const shown = [],
      c = task.collector((...a) => shown.push(a)),
      raw = JSON.stringify({ [key]: value, [other]: "概要" });
    c.append(raw);
    c.finish();
    assert.deepEqual(shown, [["b", "概要"]]);
    assert.throws(
      () => task.parse(body(raw)),
      (e) =>
        e instanceof MissingTranslationsError &&
        e.missingIds.join() === "a" &&
        e.partialTranslations.get("b") === "概要"
    );
  }
  const raw = `{"${key}":"x","${key}":"y"}`;
  assert.throws(() => task.parse(body(raw)), /形式/);
});

test("validated members preview atomically and manual repair keeps full reference context", async (t) => {
  const stream = streamFixture(),
    requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    if (requests.length === 1) return stream.response;
    const b = JSON.parse(request.input).pages[0].blocks[0],
      [model, ref] = b.original_atoms.map((a) => a.tag);
    return Response.json(
      body(
        JSON.stringify({
          [b.translate_id]: `先行研究${ref}に従い${model}を使う。`,
        })
      )
    );
  });
  const tr = createAtomTagGeminiTranslator(options),
    shown = [],
    pending = tr.translateDocument(pages(), ["a", "b"], (...a) =>
      shown.push(a)
    );
  await until(() => requests.length === 1);
  const input = JSON.parse(requests[0].input),
    [key, other] = requests[0].response_format.schema.required,
    [model, ref] = input.pages[0].blocks[0].original_atoms.map((a) => a.tag);
  stream.start();
  stream.text(`{"${key}":"モデル${model}`);
  await new Promise(setImmediate);
  assert.equal(shown.length, 0);
  stream.text(`を先行研究${ref}に従い使う。","${other}":"概要"}`);
  await until(() => shown.length === 2);
  stream.complete();
  await pending;
  const repair = await tr.translateDocument(pages(), ["a"]);
  assert.match(repair.get("a"), /RN152/);
  assert.equal(
    JSON.parse(requests[1].input).pages[1].blocks[0].text,
    pages()[1].blocks[0].text
  );
  assert.equal(
    JSON.parse(requests[1].input).pages[0].blocks[0].translate_id,
    key
  );
  assert.doesNotMatch(
    requests[0].system_instruction,
    /rank|LF-separated|Keep these unchanged:/
  );
});

test("original retention, tag collision and cancellation make no unexpected calls", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    return Response.json(
      body(
        JSON.stringify({ [request.response_format.schema.required[0]]: "概要" })
      )
    );
  });
  const source = pages();
  source[0].blocks[0].mathUncertain = true;
  const result = await createAtomTagGeminiTranslator(options).translateDocument(
    source,
    ["a", "b"]
  );
  assert.equal(result.get("a"), null);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createAtomTagGeminiTranslator({
      ...options,
      signal: controller.signal,
    }).translateDocument(pages(), ["a"]),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
  await assert.rejects(
    buildAtomTagTask(
      [{ page: 1, blocks: [{ id: "a", text: "literal <n_dead/>" }] }],
      ["a"],
      "English",
      "Japanese"
    ),
    /競合/
  );
});
