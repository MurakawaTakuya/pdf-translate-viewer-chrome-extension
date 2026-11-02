import test from "node:test";
import assert from "node:assert/strict";
import { createNodeGeminiTranslator } from "../node-translations.js";
import { createFlatNodeGeminiTranslator } from "../flat-node-translations.js";
import { createCompactNodeGeminiTranslator } from "../compact-node-translations.js";

test("complete generated prompts do not tell the model to copy registered originals into prose", async (t) => {
  for (const factory of [
    createNodeGeminiTranslator,
    createFlatNodeGeminiTranslator,
    createCompactNodeGeminiTranslator,
  ])
    await t.test(factory.name, async (s) => {
      let request;
      s.mock.method(globalThis, "fetch", async (_url, init) => {
        request = JSON.parse(init.body);
        return Response.json({
          status: "completed",
          steps: [
            { type: "model_output", content: [{ type: "text", text: "{}" }] },
          ],
        });
      });
      await factory({
        apiKey: "fixture",
        sourceLanguage: "en",
        targetLanguage: "ja",
      })
        .translateDocument(
          [
            {
              page: 1,
              blocks: [{ id: "a", text: "The model RN152 is used." }],
            },
          ],
          ["a"]
        )
        .catch(() => {});
      assert.ok(request);
      assert.doesNotMatch(request.system_instruction, /Keep these unchanged:/);
      assert.match(
        request.system_instruction,
        /Registered original atoms are restored by local code/
      );
      assert.match(request.system_instruction, /unregistered names/);
    });
});
