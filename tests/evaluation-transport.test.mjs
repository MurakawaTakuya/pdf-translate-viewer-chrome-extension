import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../scripts/evaluation/compare-formats.mjs";

test("evaluation transport accepts SSE event names and records missing completion explicitly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pdf-evaluation-transport-"));
  try {
    for (const completed of [true, false])
      await t.test(String(completed), async (s) => {
        const frames = [
          'event: step.start\ndata: {"index":0,"step":{"type":"model_output","content":[]}}',
          'event: step.delta\ndata: {"index":0,"delta":{"type":"text","text":"{\\"a\\":\\"訳\\"}"}}',
          ...(completed
            ? [
                'event: interaction.completed\ndata: {"interaction":{"status":"completed"}}',
              ]
            : []),
        ];
        s.mock.method(
          globalThis,
          "fetch",
          async () =>
            new Response(frames.join("\n\n") + "\n\n", {
              headers: { "content-type": "text/event-stream" },
            })
        );
        const result = await generate(
          {
            name: "fixture",
            protocol: "keyed-object",
            request: { model: "fixture" },
            targets: [{ id: "source", wire: "a" }],
          },
          "secret-fixture",
          String(completed),
          dir
        );
        assert.equal(result.outputText, '{"a":"訳"}');
        assert.equal(result.status, completed ? "completed" : "no-completion");
        assert.equal(
          result.error?.code,
          completed ? undefined : "no-completion"
        );
        assert.equal(result.transport.eventCounts["step.delta"], 1);
        assert.match(result.transport.sha256, /^[a-f0-9]{64}$/);
      });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
