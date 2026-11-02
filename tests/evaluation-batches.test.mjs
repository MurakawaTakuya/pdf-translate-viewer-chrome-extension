import test from "node:test";
import assert from "node:assert/strict";
import { captureBatchedDocument } from "../scripts/evaluation/batched-document.mjs";

test("multi-request capture binds every key to its matching source instead of the last batch", async () => {
  const pages = [
    {
      page: 1,
      blocks: Array.from({ length: 129 }, (_, i) => ({
        id: `b${i}`,
        text: `Source paragraph ${i} [${i + 1}].`,
        kind: "paragraph",
        translate: true,
      })),
    },
  ];
  const requests = await captureBatchedDocument(pages);
  assert.equal(requests.length, 2);
  const blocks = requests.flatMap((r) =>
    JSON.parse(r.input).pages.flatMap((p) =>
      p.blocks.filter((b) => b.translate_id)
    )
  );
  assert.equal(blocks.length, 129);
  assert.equal(new Set(blocks.map((b) => b.translate_id)).size, 129);
  assert.deepEqual(
    blocks.map((b) => b.text),
    pages[0].blocks.map((b) => b.text)
  );
  assert.ok(
    requests.every((r) => JSON.parse(r.input).pages[0].blocks.length === 129)
  );
});
