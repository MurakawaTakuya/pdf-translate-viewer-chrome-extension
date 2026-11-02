import test from "node:test";
import assert from "node:assert/strict";
import {
  captureProtected,
  replayProtected,
  mapPanel,
} from "../scripts/evaluation/protected-format.mjs";

const pages = () => [
  {
    page: 1,
    blocks: [
      {
        id: "a",
        text: "Results rely on prior work [4,5].",
        kind: "paragraph",
        translate: true,
        bbox: [0, 0, 100, 20],
      },
      {
        id: "b",
        text: "An uncertain math expression.",
        mathUncertain: true,
        translate: true,
        bbox: [0, 30, 100, 50],
      },
    ],
  },
];

test("the protected evaluator captures the actual candidate and replays its real guards with original coverage separated", async () => {
  const source = pages(),
    candidate = await captureProtected(source);
  assert.equal(candidate.targets.length, 1);
  assert.equal(candidate.originals.length, 1);
  assert.equal(candidate.request.model, "gemini-3.5-flash-lite");
  const input = JSON.parse(candidate.request.input),
    block = input.pages[0].blocks[0];
  assert.equal(input.pages[0].blocks.length, 2);
  const tag = block.protected_spans[0].tag;
  const good = await replayProtected(source, {
    status: "completed",
    outputText: JSON.stringify({
      [block.translate_id]: "先行研究" + tag + "に基づく結果です。",
    }),
  });
  assert.equal(good.accepted, true);
  assert.equal(good.translated.a, "先行研究[4,5]に基づく結果です。");
  assert.equal(good.translated.b, null);
  const bad = await replayProtected(source, {
    status: "completed",
    outputText: JSON.stringify({
      [block.translate_id]: "先行研究に基づく結果です。",
    }),
  });
  assert.equal(bad.accepted, false);
  assert.deepEqual(bad.issues, [{ id: "a", reason: "protected" }]);
  assert.equal(bad.translated.b, null);
});

test("the fixed semantic panel follows exact source text or unambiguous joined source geometry", () => {
  const old = [
    {
      page: 1,
      blocks: [
        { id: "old-a", text: "first", bbox: [0, 0, 100, 10] },
        { id: "old-b", text: "second", bbox: [0, 10, 100, 20] },
      ],
    },
  ];
  const current = [
    {
      page: 1,
      blocks: [
        {
          id: "new",
          text: "first second",
          translate: true,
          bbox: [0, 0, 100, 20],
        },
      ],
    },
  ];
  assert.deepEqual(
    mapPanel(old, current, ["old-a", "old-b"]).map((m) => m.current),
    ["new", "new"]
  );
  assert.throws(
    () => mapPanel(old, [{ page: 1, blocks: [] }], ["old-a"]),
    /Ambiguous/
  );
});
