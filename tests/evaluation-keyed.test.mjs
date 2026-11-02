import test from "node:test";
import assert from "node:assert/strict";
import { keyedCase } from "../scripts/evaluation/keyed-format.mjs";
import { captureCurrent } from "../scripts/evaluation/reproduce-current.mjs";
import { analyze } from "../scripts/evaluation/compare-formats.mjs";
const pages = [
  {
    page: 1,
    blocks: [
      { id: "p1-b0", text: "Context label", translate: false },
      { id: "p1-b1", text: "First source", translate: true },
      { id: "p1-b2", text: "Second source", translate: true },
    ],
  },
];

test("keyed evaluation preserves full source, quality instructions and single-request budget", async () => {
  const candidate = await keyedCase(pages),
    current = await captureCurrent(pages, { format: "legacy" });
  const input = JSON.parse(candidate.request.input),
    before = JSON.parse(current.request.input);
  assert.deepEqual(
    input.pages[0].blocks.map((b) => b.text),
    before.pages[0].blocks.map((b) => b.text)
  );
  assert.equal(input.pages[0].blocks[0].translate_id, undefined);
  assert.deepEqual(
    candidate.request.generation_config,
    current.request.generation_config
  );
  assert.equal(candidate.request.model, current.request.model);
  assert.equal(candidate.request.stream, true);
  assert.equal(candidate.request.store, false);
  assert.match(
    candidate.request.system_instruction,
    /Read the entire paper for context/
  );
  assert.match(
    candidate.request.system_instruction,
    /Preserve negation and its scope/
  );
  assert.deepEqual(
    candidate.request.response_format.schema.required,
    candidate.targets.map((b) => b.wire)
  );
  assert.equal(
    candidate.request.response_format.schema.additionalProperties,
    false
  );
});

test("keyed coverage accepts reordered properties and rejects duplicate, missing and unknown keys", async () => {
  const candidate = await keyedCase(pages),
    [a, b] = candidate.targets.map((t) => t.wire);
  assert.equal(
    analyze(
      candidate,
      JSON.stringify({ [b]: "二番目", [a]: "最初" }),
      "completed"
    ).valid,
    true
  );
  const duplicate = analyze(
    candidate,
    `{"${a}":"最初","${a}":"重複","${b}":"二番目"}`,
    "completed"
  );
  assert.equal(duplicate.duplicate, 1);
  assert.equal(duplicate.valid, false);
  const escaped =
    "\\u" + a.charCodeAt(0).toString(16).padStart(4, "0") + a.slice(1);
  assert.equal(
    analyze(
      candidate,
      `{"${a}":"一","${escaped}":"重複","${b}":"二"}`,
      "completed"
    ).duplicate,
    1
  );
  assert.equal(
    analyze(candidate, JSON.stringify({ [a]: "最初" }), "completed").missing,
    1
  );
  assert.equal(
    analyze(
      candidate,
      JSON.stringify({ [a]: "一", [b]: "二", unknown: "不明" }),
      "completed"
    ).unknown,
    1
  );
  for (const value of [123, {}, [], null, true]) {
    const overwritten = `{"${a}":${JSON.stringify(value)},"${a}":"訳A","${b}":"訳B"}`;
    assert.equal(analyze(candidate, overwritten, "completed").valid, false);
  }
});

test("quoted delimiters cannot invent keys and empty, nested or incomplete values cannot pass", async () => {
  const candidate = await keyedCase(pages),
    [a, b] = candidate.targets.map((t) => t.wire);
  const safe = analyze(
    candidate,
    JSON.stringify({ [a]: 'quoted "key":"value" and \\ slash', [b]: "二" }),
    "completed"
  );
  assert.equal(safe.valid, true);
  assert.equal(
    analyze(candidate, JSON.stringify({ [a]: " ", [b]: "二" }), "completed")
      .empty,
    1
  );
  assert.equal(
    analyze(
      candidate,
      JSON.stringify({ [a]: { text: "一" }, [b]: "二" }),
      "completed"
    ).valid,
    false
  );
  assert.equal(
    analyze(candidate, JSON.stringify({ [a]: "一", [b]: "二" }), "incomplete")
      .valid,
    false
  );
});

test("source-bound candidate adds only exact source descriptions without changing context, keys or output values", async () => {
  const plain = await keyedCase(pages),
    bound = await keyedCase(pages, { sourceBound: true });
  assert.equal(plain.request.input, bound.request.input);
  assert.equal(
    plain.request.system_instruction,
    bound.request.system_instruction
  );
  assert.deepEqual(
    plain.request.response_format.schema.required,
    bound.request.response_format.schema.required
  );
  for (const target of bound.targets) {
    const property =
      bound.request.response_format.schema.properties[target.wire];
    assert.equal(property.type, "string");
    assert.ok(property.description.endsWith(JSON.stringify(target.text)));
    assert.equal(
      plain.request.response_format.schema.properties[target.wire].description,
      undefined
    );
  }
});

test("task-bound descriptions explicitly request translation without changing source or output schema shape", async () => {
  const source = await keyedCase(pages, { sourceBound: true });
  const task = await keyedCase(pages, { sourceBound: true, taskBound: true });
  assert.equal(task.request.input, source.request.input);
  assert.equal(
    task.request.system_instruction,
    source.request.system_instruction
  );
  assert.deepEqual(
    task.request.response_format.schema.required,
    source.request.response_format.schema.required
  );
  for (const target of task.targets) {
    const property =
      task.request.response_format.schema.properties[target.wire];
    assert.equal(property.type, "string");
    assert.match(property.description, /from English into Japanese/);
    assert.ok(property.description.includes(JSON.stringify(target.text)));
  }
});
