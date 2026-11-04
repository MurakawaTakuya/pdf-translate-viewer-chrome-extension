import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { nearbyContext } from "../block-context.js";
import { createDocumentTranslator } from "../document-translator.js";
import {
  createKeyedGeminiTranslator,
  MissingTranslationsError,
} from "../gemini.js";
import { buildKeyedTask } from "../keyed-translations.js";

const options = {
  apiKey: "fixture-key",
  sourceLanguage: "en",
  targetLanguage: "ja",
};
const content = (request) =>
  JSON.parse(request.input).pages.flatMap((p) => p.blocks);
const fixture = (count = 20) =>
  Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    blocks: Array.from({ length: 8 }, (_, j) => ({
      text: `Page ${i + 1} paragraph ${j}.`,
      kind: "paragraph",
      translate: true,
    })),
  }));
const response = (request, text = "訳文") =>
  Response.json({
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: JSON.stringify(
              Object.fromEntries(
                request.response_format.schema.required.map((k) => [k, text])
              )
            ),
          },
        ],
      },
    ],
  });

test("a selected paragraph reads only nearby pages, sends two neighbors on each side, and keeps the same target key", async (t) => {
  const rows = fixture(),
    reads = [],
    requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    return response(r);
  });
  const tr = createDocumentTranslator({
    rows,
    getBlocks: async (r) => {
      reads.push(r.index);
      return r.blocks;
    },
    translator: createKeyedGeminiTranslator(options),
  });
  const b = rows[9].blocks[3];
  const out = await tr.translateSelectedBlocks(b, () => {}, { row: rows[9] });
  assert.equal(out.size, 1);
  assert.deepEqual(reads, [9, 10, 11]);
  assert.deepEqual(
    content(requests[0]).map((b) => b.text),
    rows[9].blocks.slice(1, 6).map((b) => b.text)
  );
  assert.equal(content(requests[0]).filter((b) => b.translate_id).length, 1);
  assert.match(
    requests[0].system_instruction,
    /excerpts surrounding the target/
  );
  assert.doesNotMatch(requests[0].system_instruction, /Read the entire paper/);
  assert.doesNotMatch(requests[0].system_instruction, /Use the entire paper/);
  assert.equal(tr.completed, false);
  const full = await tr.translateSelectedBlocks(b, () => {}, {
    context: "full",
    row: rows[9],
  });
  assert.equal(full.size, 1);
  assert.equal(content(requests[1]).length, 160);
  assert.equal(reads.length, 20);
  assert.deepEqual(
    requests[0].response_format.schema.required,
    requests[1].response_format.schema.required
  );
  assert.ok(requests[1].input.length > requests[0].input.length * 10);
  assert.match(requests[1].system_instruction, /Read the entire paper/);
});

test("explicit full context makes a fresh request even if the chosen translation is cached", async (t) => {
  const rows = fixture(5);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    return response(JSON.parse(init.body), "新しい全文参照の訳");
  });
  const b = rows[2].blocks[3];
  const tr = createDocumentTranslator({
    rows,
    getBlocks: (r) => r.blocks,
    getCached: (x) => (x === b ? "以前の訳" : undefined),
    translator: createKeyedGeminiTranslator(options),
  });
  assert.equal((await tr.translateSelectedBlocks(b)).get(b), "以前の訳");
  assert.equal(calls, 0);
  assert.equal(
    (await tr.translateSelectedBlocks(b, () => {}, { context: "full" })).get(b),
    "新しい全文参照の訳"
  );
  assert.equal(calls, 1);
});

test("a cropped context cannot manufacture a page-continuation citation group", async () => {
  const pages = [
    {
      page: 1,
      blocks: [
        { id: "a", kind: "paragraph", translate: true, text: "We match view-" },
        {
          id: "omitted",
          kind: "paragraph",
          translate: true,
          text: "Unrelated text.",
        },
      ],
    },
    {
      page: 2,
      blocks: [
        {
          id: "b",
          kind: "paragraph",
          translate: true,
          text: "invariant methods [79].",
        },
      ],
    },
  ];
  const a = nearbyContext([pages[0]], ["a"], 0)[0];
  const b = nearbyContext([pages[1]], ["b"], 0)[0];
  const task = await buildKeyedTask([a, b], ["a", "b"], "English", "Japanese");
  assert.equal(a.endComplete, false);
  assert.ok([...task.groups.values()].every((g) => g.length === 1));
});

test("a real cross-page continuation keeps both output fragments when nearby context is selected", async (t) => {
  const data = JSON.parse(
    await readFile(
      new URL("./fixtures/ijepa-page-continuation.json", import.meta.url)
    )
  );
  const rows = data.pages.map((p) => ({ index: p.page, blocks: p.blocks }));
  let request;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    request = JSON.parse(init.body);
    return Response.json({
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify(
                Object.fromEntries(
                  request.response_format.schema.required.map((k, i) => [
                    k,
                    data.translations[i],
                  ])
                )
              ),
            },
          ],
        },
      ],
    });
  });
  const tr = createDocumentTranslator({
    rows,
    getBlocks: (r) => r.blocks,
    translator: createKeyedGeminiTranslator(options),
  });
  const out = await tr.translateSelectedBlocks(rows[1].blocks.at(-1));
  assert.equal(out.size, 2);
  assert.deepEqual([...out.values()], data.translations);
  assert.equal(request.response_format.schema.required.length, 2);
});

test("an invalid nearby result does not automatically retry with the entire document", async (t) => {
  const rows = fixture(10);
  let calls = 0;
  rows[4].blocks[3].text = "Prior work [79].";
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    return response(JSON.parse(init.body), "引用を落とした訳");
  });
  const tr = createDocumentTranslator({
    rows,
    getBlocks: (r) => r.blocks,
    translator: createKeyedGeminiTranslator(options),
  });
  await assert.rejects(
    tr.translateSelectedBlocks(rows[4].blocks[3]),
    MissingTranslationsError
  );
  assert.equal(calls, 1);
});

test("whole-document translation and missing repair retain all pages while manual redo defaults to nearby context", async (t) => {
  const rows = fixture(8),
    requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    return response(r);
  });
  const tr = createDocumentTranslator({
    rows,
    getBlocks: (r) => r.blocks,
    translator: createKeyedGeminiTranslator(options),
  });
  await tr.ready();
  assert.equal(content(requests[0]).length, 64);
  assert.equal(tr.completed, true);
  const b = rows[3].blocks[3];
  await tr.retranslateBlocks(b);
  assert.equal(content(requests[1]).length, 5);
  assert.equal(content(requests[1]).filter((x) => x.translate_id).length, 1);
  await tr.retranslateBlocks(b, { context: "full" });
  assert.equal(content(requests[2]).length, 64);
  assert.equal(tr.completed, true);
});
