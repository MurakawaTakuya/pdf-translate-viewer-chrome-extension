import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentTranslator } from "../document-translator.js";
import { createKeyedGeminiTranslator } from "../gemini.js";
const options = {
  apiKey: "mock-key",
  sourceLanguage: "en",
  targetLanguage: "ja",
};
const body = (out) => ({
  status: "completed",
  steps: [
    {
      type: "model_output",
      content: [{ type: "text", text: JSON.stringify(out) }],
    },
  ],
});

test("selected translation reads full context and generates only the selected atomic group without ready", async (t) => {
  const rows = [{ index: 1 }, { index: 2 }],
    blocks = [
      [
        {
          text: "Before the selected passage.",
          translate: true,
          kind: "paragraph",
        },
        { text: "We train for 300,000", translate: true, kind: "paragraph" },
        {
          text: "iterations using settings [13].",
          translate: true,
          kind: "paragraph",
        },
      ],
      [{ text: "A distant definition and reference.", translate: false }],
    ],
    requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    const keys = r.response_format.schema.required;
    return Response.json(
      body({ [keys[0]]: "300,000", [keys[1]]: "反復、設定[13]を用いる。" })
    );
  });
  const tr = createDocumentTranslator({
      rows,
      getBlocks: async (r) => blocks[r.index - 1],
      translator: createKeyedGeminiTranslator(options),
    }),
    reserved = [];
  const result = await tr.translateSelectedBlocks(blocks[0][1], (b) =>
    reserved.push(...b)
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].response_format.schema.required.length, 2);
  assert.equal(result.size, 2);
  assert.deepEqual(reserved, blocks[0].slice(1));
  const input = JSON.parse(requests[0].input);
  assert.equal(input.pages.length, 2);
  assert.equal(input.pages[1].blocks[0].text, blocks[1][0].text);
  assert.equal(input.pages[0].blocks[0].translate_id, undefined);
  assert.equal(tr.completed, false);
  assert.equal(blocks[0][0].ja, undefined);
});

test("selected cached translations do not send requests unless explicitly redone; exclusions remain excluded", async (t) => {
  const b = {
      text: "The original paragraph.",
      kind: "paragraph",
      translate: true,
    },
    excluded = { text: "References", translate: false },
    row = { index: 1 };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const r = JSON.parse(init.body);
    return Response.json(
      body({ [r.response_format.schema.required[0]]: "新しい訳" })
    );
  });
  const tr = createDocumentTranslator({
    rows: [row],
    getBlocks: async () => [b, excluded],
    getCached: (block) => (block === b ? "既存のGemini訳" : undefined),
    translator: createKeyedGeminiTranslator(options),
  });
  assert.equal((await tr.translateSelectedBlocks(b)).get(b), "既存のGemini訳");
  assert.equal(calls, 0);
  assert.equal(
    (await tr.translateSelectedBlocks(b, () => {}, { force: true })).get(b),
    "新しい訳"
  );
  assert.equal(calls, 1);
  await assert.rejects(
    tr.translateSelectedBlocks(excluded),
    /対象ではありません/
  );
  assert.equal(calls, 1);
});
