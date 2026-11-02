import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompactNodeTask,
  createCompactNodeGeminiTranslator,
  compactNodePrompt,
} from "../compact-node-translations.js";
import { MissingTranslationsError } from "../gemini.js";
import { streamFixture, until } from "./helpers/stream.mjs";
const pages = () => [
  {
    page: 1,
    blocks: [
      {
        id: "a",
        text: "The model RN152 is used following prior work [4].",
        kind: "paragraph",
      },
      { id: "b", text: "Abstract", kind: "heading" },
    ],
  },
];
const body = (text) => ({
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text }] }],
});
const translation = "1:に従いモデル\n0:先行研究\nを使う。";
test("one string per block retains source slot identity and independently reorders Japanese occurrences", async () => {
  const task = await buildCompactNodeTask(
      pages(),
      ["a", "b"],
      "English",
      "Japanese"
    ),
    [key, other] = task.byKey.keys();
  assert.equal(task.schema.required.length, 2);
  assert.ok(
    Object.values(task.schema.properties).every((p) => p.type === "string")
  );
  assert.equal(
    task
      .parse(body(JSON.stringify({ [key]: translation, [other]: "概要" })))
      .get("a"),
    "先行研究[4]に従いモデルRN152を使う。"
  );
  assert.deepEqual(
    task.input.pages[0].blocks[0].source_parts
      .filter((p) => p.atom)
      .map((p) => p.line),
    [1, 2]
  );
});
test("exact record count, ranks and empty trailing tail are validated without trimming or repair", async () => {
  const task = await buildCompactNodeTask(
      pages(),
      ["a", "b"],
      "English",
      "Japanese"
    ),
    [key, other] = task.byKey.keys();
  for (const bad of [
    "0:モデル\nを使う。",
    "0:モデル\n0:引用\nを使う。",
    "01:モデル\n0:引用\nを使う。",
    translation + "\n余分",
    translation.replaceAll("\n", "\r\n"),
  ]) {
    assert.throws(
      () => task.parse(body(JSON.stringify({ [key]: bad, [other]: "概要" }))),
      (e) =>
        e instanceof MissingTranslationsError &&
        e.partialTranslations.get("b") === "概要"
    );
  }
  const noTail = "0:モデル\n1:の情報：参照\n";
  assert.match(
    task
      .parse(body(JSON.stringify({ [key]: noTail, [other]: "概要" })))
      .get("a"),
    /RN152の情報：参照\[4\]$/
  );
  assert.throws(
    () =>
      task.parse(
        body(JSON.stringify({ [key]: noTail.trimEnd(), [other]: "概要" }))
      ),
    MissingTranslationsError
  );
});
test("a compact string is previewed only after all records and its JSON member finish", async (t) => {
  const stream = streamFixture();
  let request;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    request = JSON.parse(init.body);
    return stream.response;
  });
  const shown = [],
    pending = createCompactNodeGeminiTranslator({
      apiKey: "fixture",
      sourceLanguage: "en",
      targetLanguage: "ja",
    }).translateDocument(pages(), ["a", "b"], (...a) => shown.push(a));
  await until(() => !!request);
  const [key, other] = request.response_format.schema.required;
  stream.start();
  const raw = JSON.stringify({ [key]: translation, [other]: "概要" }),
    at = raw.indexOf("\\n");
  stream.text(raw.slice(0, at));
  await new Promise(setImmediate);
  assert.equal(shown.length, 0);
  stream.text(raw.slice(at));
  await until(() => shown.length === 2);
  stream.complete();
  assert.equal((await pending).size, 2);
});
test("compact prompt describes source slots separately from Japanese ranks", () => {
  const prompt = compactNodePrompt(
    "- Return a JSON object with translations.\n- Write every mathematical expression as inline LaTeX.",
    "English",
    "Japanese"
  );
  assert.match(prompt, /SOURCE SLOT order/);
  assert.match(prompt, /trailing LF/);
  assert.ok(!prompt.includes("as inline LaTeX"));
});

test("a rank-prefixed tail and copied original numeric tuple are withheld before preview", async () => {
  const text = "multi-block Block(0.15, 0.2)",
    source = [
      {
        page: 1,
        blocks: [
          {
            id: "tuple",
            text,
            kind: "paragraph",
            mathSpans: [{ start: 17, end: text.length, text: text.slice(17) }],
          },
        ],
      },
    ];
  const task = await buildCompactNodeTask(
      source,
      ["tuple"],
      "English",
      "Japanese"
    ),
    [key] = task.byKey.keys();
  for (const value of [
    "0:マルチブロック Block\n1:(0.15, 0.2)",
    "0:マルチブロック Block\n (0.15,0.2)",
  ]) {
    const shown = [],
      collector = task.collector((...a) => shown.push(a)),
      json = JSON.stringify({ [key]: value });
    collector.append(json);
    collector.finish();
    assert.deepEqual(shown, []);
    assert.throws(() => task.parse(body(json)), MissingTranslationsError);
  }
  assert.match(
    task
      .parse(body(JSON.stringify({ [key]: "0:マルチブロック Block\n" })))
      .get("tuple"),
    /^マルチブロック Block<m_/
  );
});

test("bibliography years and source numeric colon labels are not mistaken for leaked ranks", async () => {
  for (const text of [
    "[4]2020: Learning representation methods.",
    "[4]1: Learning representation methods.",
  ]) {
    const task = await buildCompactNodeTask(
        [{ page: 1, blocks: [{ id: "a", kind: "reference", text }] }],
        ["a"],
        "English",
        "Japanese"
      ),
      [key] = task.byKey.keys();
    assert.equal(
      task
        .parse(body(JSON.stringify({ [key]: `0:\n${text.slice(3)}` })))
        .get("a"),
      text
    );
  }
});
