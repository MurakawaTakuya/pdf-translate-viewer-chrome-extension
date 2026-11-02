import test from "node:test";
import assert from "node:assert/strict";
import { makeCases, analyze } from "../scripts/evaluation/compare-formats.mjs";

const pages = [
  {
    page: 1,
    blocks: [
      { id: "p1-b0", text: "Reference text", translate: false },
      { id: "p1-b1", text: "First paragraph", translate: true },
    ],
  },
  {
    page: 2,
    blocks: [{ id: "p2-b0", text: "Second paragraph", translate: true }],
  },
];

test("comparison retains the same full source context, model, budget and quality instructions", async () => {
  const cases = await makeCases(pages),
    a = cases.A.request,
    b = cases.B.request;
  const content = (request) =>
    JSON.parse(request.input).pages.map((p) =>
      p.blocks.map((block) => block.text)
    );
  assert.deepEqual(content(a), content(b));
  assert.equal(a.model, b.model);
  assert.deepEqual(a.generation_config, b.generation_config);
  assert.equal(a.stream, true);
  assert.equal(b.stream, true);
  assert.equal(a.store, false);
  assert.equal(b.store, false);
  assert.match(b.system_instruction, /Preserve negation and its scope/);
  assert.match(b.system_instruction, /Read the entire paper for context/);
  assert.match(b.system_instruction, /opaque labels/);
  assert.equal(new Set(cases.B.targets.map((block) => block.wire)).size, 2);
  assert.deepEqual(
    cases.A.targets.map((block) => block.wire),
    [1, 2]
  );
});

test("coverage checker accepts complete responses in either protocol regardless of response order", async () => {
  const cases = await makeCases(pages);
  const a = analyze(
    cases.A,
    JSON.stringify({
      translations: [
        { id: 2, text: "二番目" },
        { id: 1, text: "最初" },
      ],
    }),
    "completed"
  );
  const b = analyze(
    cases.B,
    JSON.stringify({
      pages: cases.B.targets.map((block) => ({
        page: block.page,
        translations: [{ id: block.wire, text: "訳文" }],
      })),
    }),
    "completed"
  );
  assert.equal(a.valid, true);
  assert.equal(b.valid, true);
  assert.equal(a.translated["p1-b1"], "最初");
  assert.equal(b.missing, 0);
});

test("missing or duplicate IDs, wrong pages and incomplete status cannot pass the evaluation", async () => {
  const cases = await makeCases(pages);
  const a = analyze(
    cases.A,
    '{"translations":[{"id":1,"text":"訳"},{"id":1,"text":"重複"}]}',
    "completed"
  );
  assert.equal(a.valid, false);
  assert.equal(a.missing, 1);
  assert.equal(a.duplicate, 1);
  assert.deepEqual(a.missingPositions, [2]);
  assert.equal(a.missingByPage[2], 1);
  const b = analyze(
    cases.B,
    JSON.stringify({
      pages: [
        {
          page: 1,
          translations: cases.B.targets.map((block) => ({
            id: block.wire,
            text: "訳",
          })),
        },
      ],
    }),
    "completed"
  );
  assert.equal(b.valid, false);
  assert.equal(b.wrongPage, 1);
  const complete = JSON.stringify({
    translations: [
      { id: 1, text: "一" },
      { id: 2, text: "二" },
    ],
  });
  assert.equal(analyze(cases.A, complete, "incomplete").valid, false);
  assert.equal(analyze(cases.A, "{", "completed").valid, false);
});
