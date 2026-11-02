// Offline preparation is the default. --run explicitly authorizes at most four model requests.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { DEFAULT_MODEL } from "../../gemini.js";
import { legacyRequest } from "./legacy-format.mjs";
import { readApiError, redactApiError } from "../../api-error.js";

const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const itemSchema = (type) => ({
  type: "object",
  properties: { id: { type }, text: { type: "string" } },
  required: ["id", "text"],
  additionalProperties: false,
});
const array = (items) => ({ type: "array", items });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export async function makeCases(pages) {
  const targets = pages.flatMap((p) =>
    p.blocks.filter((b) => b.translate).map((b) => ({ ...b, page: p.page }))
  );
  const inputPages = pages.map((p) => ({
    page: p.page,
    blocks: p.blocks.map(({ id, text }) => ({ id, text })),
  }));
  const baseline = legacyRequest(
    inputPages,
    targets.map((b) => b.id),
    DEFAULT_MODEL
  );
  const used = new Set();
  const keyed = targets.map((b) => {
    let length = 6,
      wire;
    do {
      wire = sha(b.id).slice(0, length++);
    } while (used.has(wire));
    used.add(wire);
    return { ...b, wire };
  });
  const ids = new Map(keyed.map((b) => [b.id, b.wire]));
  const candidate = structuredClone(baseline);
  const prefix =
    'The user sends a JSON object whose "pages" array contains text blocks extracted from every page of a PDF paper, in reading order. Every block has "text". A block with a string "translate_id" is a target to translate from English into Japanese; blocks without "translate_id" are reference context only. Target identifiers are opaque labels, not sequence numbers. Each page has its own "translate_count", and the document also has a total "translate_count".';
  const rule =
    '- Return a JSON object of the form {"pages": [{"page": 1, "translations": [{"id": "a3c9f1", "text": "translated text"}]}]}. Group results by the input page number. Copy each target\'s string "translate_id" unchanged into "id" and put its nonempty translation in "text". Return every input page and exactly its "translate_count" target items, in input reading order, covering every target once. Never invent, renumber, merge, split, or skip target identifiers, and never include reference-only blocks. Before finishing, check that every target identifier has a translation. A sentence may continue across blocks or pages: use the neighboring text to understand it, but translate only the content belonging to each block, without duplicating or inventing text.';
  candidate.system_instruction = baseline.system_instruction
    .replace(/^The user sends.*$/m, prefix)
    .replace(/^- Return a JSON object.*$/m, rule)
    .replaceAll("all target numbers", "all target identifiers");
  candidate.input = JSON.stringify({
    pages: pages.map((p) => ({
      page: p.page,
      translate_count: p.blocks.filter((b) => b.translate).length,
      blocks: p.blocks.map((b) =>
        ids.has(b.id)
          ? { translate_id: ids.get(b.id), text: b.text }
          : { text: b.text }
      ),
    })),
    translate_count: targets.length,
  });
  candidate.response_format.schema = object({
    pages: array(
      object({
        page: { type: "integer" },
        translations: array(itemSchema("string")),
      })
    ),
  });
  return {
    A: {
      name: "sequential-flat",
      request: baseline,
      targets: targets.map((b, i) => ({ ...b, wire: i + 1 })),
    },
    B: { name: "opaque-page-grouped", request: candidate, targets: keyed },
  };
}

function keyedEntries(text) {
  let position = 0;
  const space = () => {
    while (/\s/.test(text[position] || "") && position < text.length)
      position++;
  };
  const token = (expected) => {
    space();
    if (text[position++] !== expected) throw new Error("invalid-keyed-object");
  };
  const string = () => {
    space();
    const start = position;
    if (text[position++] !== '"') throw new Error("invalid-keyed-value");
    while (position < text.length) {
      const char = text[position++];
      if (char === "\\") position++;
      else if (char === '"') return JSON.parse(text.slice(start, position));
    }
    throw new Error("unterminated-keyed-string");
  };
  const entries = [];
  token("{");
  space();
  if (text[position] !== "}")
    for (;;) {
      const id = string();
      token(":");
      const value = string();
      entries.push({ id, text: value });
      space();
      if (text[position] !== ",") break;
      position++;
    }
  token("}");
  space();
  if (position !== text.length) throw new Error("invalid-keyed-suffix");
  return entries;
}

export function analyze(variant, text, status) {
  let output;
  try {
    output = JSON.parse(text);
  } catch {
    return { valid: false, reason: "invalid-json", status };
  }
  const expected = new Map(
    variant.targets.map((b, i) => [b.wire, { ...b, position: i + 1 }])
  );
  let entries,
    invalid = 0,
    wrongPage = 0,
    duplicatePages = 0;
  if (variant.protocol === "keyed-object") {
    if (
      !output ||
      Array.isArray(output) ||
      typeof output !== "object" ||
      Object.values(output).some((value) => typeof value !== "string")
    ) {
      return { valid: false, reason: "invalid-keyed-object", status };
    }
    // Read every raw member: JSON.parse can hide a repeated non-string value.
    try {
      entries = keyedEntries(text);
    } catch {
      return { valid: false, reason: "invalid-keyed-object", status };
    }
  } else if ((variant.protocol || variant.name) === "sequential-flat")
    entries = output.translations;
  else {
    if (!Array.isArray(output.pages))
      return { valid: false, reason: "invalid-pages", status };
    const seenPages = new Set();
    entries = [];
    for (const p of output.pages) {
      if (!Number.isInteger(p.page) || !Array.isArray(p.translations)) {
        invalid++;
        continue;
      }
      if (seenPages.has(p.page)) duplicatePages++;
      seenPages.add(p.page);
      for (const item of p.translations) {
        if (expected.has(item?.id) && expected.get(item.id).page !== p.page)
          wrongPage++;
        entries.push(item);
      }
    }
  }
  if (!Array.isArray(entries))
    return { valid: false, reason: "invalid-translations", status };
  let unknown = 0,
    duplicate = 0,
    empty = 0;
  const seen = new Set(),
    translated = {};
  for (const item of entries) {
    if (
      !item ||
      Object.keys(item).length !== 2 ||
      !Object.hasOwn(item, "id") ||
      typeof item.text !== "string"
    ) {
      invalid++;
      continue;
    }
    if (!expected.has(item.id)) unknown++;
    if (seen.has(item.id)) duplicate++;
    seen.add(item.id);
    if (!item.text.trim()) empty++;
    const target = expected.get(item.id);
    if (target) translated[target.id] = item.text;
  }
  const missing = variant.targets.filter((b) => !seen.has(b.wire));
  const missingPositions = missing.map((b) => expected.get(b.wire).position);
  const missingByPage = Object.fromEntries(
    [...new Set(variant.targets.map((b) => b.page))].map((p) => [
      p,
      missing.filter((b) => b.page === p).length,
    ])
  );
  return {
    valid:
      status === "completed" &&
      entries.length === expected.size &&
      !missing.length &&
      !unknown &&
      !duplicate &&
      !empty &&
      !invalid &&
      !wrongPage &&
      !duplicatePages,
    status,
    expected: expected.size,
    received: entries.length,
    missing: missing.length,
    duplicate,
    unknown,
    empty,
    invalid,
    wrongPage,
    duplicatePages,
    missingPositions,
    missingByPage,
    translated,
  };
}

function objectCollector(onItem) {
  let text = "",
    position = 0,
    quoted = false,
    escaped = false;
  const starts = [];
  return (chunk) => {
    text += chunk;
    for (; position < text.length; position++) {
      const c = text[position];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (c === "{") starts.push(position);
      if (c === "}" && starts.length) {
        const begin = starts.pop();
        try {
          const value = JSON.parse(text.slice(begin, position + 1));
          if (
            Object.keys(value).length === 2 &&
            Object.hasOwn(value, "id") &&
            typeof value.text === "string"
          )
            onItem(value);
        } catch {
          /* final JSON validation remains required */
        }
      }
    }
  };
}

export async function generate(
  variant,
  apiKey,
  label,
  directory,
  analyzeOutput = analyze
) {
  const started = performance.now(),
    expected = new Set(variant.targets.map((b) => b.wire));
  let firstTextMs = null,
    firstItemMs = null,
    text = "",
    terminal = {},
    http,
    error = null,
    chunks = 0,
    contentType = "";
  const eventCounts = new Map(),
    transportHash = createHash("sha256");
  let transportBytes = 0;
  const steps = new Map();
  const collector = objectCollector((item) => {
    if (firstItemMs === null && expected.has(item.id) && item.text.trim())
      firstItemMs = performance.now() - started;
  });
  const append = (value) => {
    if (!value) return;
    firstTextMs ??= performance.now() - started;
    text += value;
    collector(value);
    chunks++;
  };
  function event(frame) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const value = JSON.parse(data);
    const type =
      value.event_type ||
      frame
        .split(/\r?\n/)
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim();
    eventCounts.set(
      type || "unknown",
      (eventCounts.get(type || "unknown") || 0) + 1
    );
    if (type === "step.start") {
      steps.set(value.index, value.step.type);
      if (value.step.type === "model_output")
        for (const c of value.step.content || [])
          if (c.type === "text") append(c.text);
    }
    if (
      type === "step.delta" &&
      steps.get(value.index) === "model_output" &&
      value.delta.type === "text"
    )
      append(value.delta.text);
    if (type === "step.stop") steps.delete(value.index);
    if (type === "interaction.completed") terminal = value.interaction;
    if (
      type === "interaction.status_update" &&
      ["failed", "cancelled", "incomplete"].includes(value.status)
    )
      error = {
        code: value.status,
        message: `Interaction ended with ${value.status}`,
      };
    if (type === "error")
      error = { code: value.error?.code, message: value.error?.message };
  }
  const progress = setInterval(
    () =>
      console.log(
        JSON.stringify({
          label,
          elapsedSeconds: Math.round((performance.now() - started) / 1000),
          outputChars: text.length,
        })
      ),
    15000
  );
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(variant.request),
      signal: AbortSignal.timeout(variant.timeoutMs || 600000),
    });
    http = response.status;
    contentType = response.headers.get("content-type") || "";
    if (!response.ok) error = await readApiError(response);
    else if (
      /text\/event-stream/i.test(response.headers.get("content-type") || "")
    ) {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        transportHash.update(chunk);
        transportBytes += chunk.byteLength;
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          event(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) event(buffer);
    } else {
      const body = await response.json();
      terminal = body;
      for (const s of body.steps || [])
        if (s.type === "model_output")
          for (const c of s.content || [])
            if (c.type === "text") append(c.text);
    }
  } catch (failure) {
    error = { name: failure.name, message: failure.message };
  } finally {
    clearInterval(progress);
  }
  if (http >= 200 && http < 300 && !terminal.status && !error)
    error = {
      code: "no-completion",
      message: "Response ended without a terminal interaction status",
    };
  const result = {
    label,
    variant: variant.name,
    model: variant.request.model,
    http,
    status: terminal.status || "no-completion",
    usage: terminal.usage || null,
    timing: { totalMs: performance.now() - started, firstTextMs, firstItemMs },
    chunks,
    outputChars: text.length,
    transport: {
      contentType,
      bytes: transportBytes,
      sha256: transportBytes ? transportHash.digest("hex") : null,
      eventCounts: Object.fromEntries(eventCounts),
    },
    error: error
      ? redactApiError(
          {
            code: error.code,
            status: error.status,
            message: String(error.message || ""),
            ...(error.details ? { details: error.details } : {}),
          },
          apiKey
        )
      : null,
    analysis: analyzeOutput(variant, text, terminal.status),
    outputText: text,
  };
  await writeFile(
    `${directory}/${label}.json`,
    JSON.stringify(result, null, 2)
  );
  const { translated, ...summary } = result.analysis;
  console.log(
    JSON.stringify({
      label,
      status: result.status,
      http,
      seconds: Math.round(result.timing.totalMs / 1000),
      usage: result.usage,
      ...summary,
    })
  );
  return result;
}

async function main() {
  const args = process.argv.slice(2),
    arg = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--input") || !args.includes("--output"))
    throw new Error(
      "Required: --input pages.json --output directory; --run --project ID --key-resource NAME explicitly enables four calls"
    );
  const input = await readFile(arg("--input"), "utf8"),
    directory = arg("--output");
  let previousRun = false;
  try {
    await access(`${directory}/summary.json`);
    previousRun = true;
  } catch {
    /* new output directory */
  }
  if (previousRun)
    throw new Error(
      "Completed or partial run exists; choose a new output directory instead of overwriting results"
    );
  const cases = await makeCases(JSON.parse(input));
  await mkdir(directory, { recursive: true });
  const recordedAt = (
    await promisify(execFile)("date", ["+%Y-%m-%dT%H:%M:%S%z"])
  ).stdout.trim();
  const plan = {
    recordedAt,
    model: DEFAULT_MODEL,
    inputSha256: sha(input),
    targets: cases.A.targets.length,
    pages: JSON.parse(input).length,
    order: ["A1", "B1", "B2", "A2"],
    maximumGenerationRequests: 4,
    retries: 0,
    semanticPanel: [
      "p1-b0",
      "p1-b12",
      "p1-b13",
      "p1-b14",
      "p1-b39",
      "p1-b41",
      "p2-b7",
      "p2-b15",
      "p2-b25",
      "p2-b26",
      "p2-b27",
      "p2-b28",
      "p2-b35",
      "p2-b36",
      "p6-b30",
      "p6-b33",
      "p6-b38",
      "p6-b64",
      "p6-b70",
      "p7-b52",
    ],
    primary:
      "ID coverage, duplicates, unknown IDs, wrong-page assignment; manual semantic checks on fixed source blocks are also required.",
    secondary:
      "Time to first complete paragraph, total latency, output/total/thought tokens.",
    stopping:
      "Stop on HTTP errors or missing completion; no key creation, model changes, API enabling or billing changes.",
    project: args.includes("--project") ? arg("--project") : null,
    requests: Object.fromEntries(
      Object.entries(cases).map(([id, c]) => [
        id,
        {
          sha256: sha(JSON.stringify(c.request)),
          protocol: c.name,
          inputChars: c.request.input.length,
        },
      ])
    ),
  };
  await writeFile(`${directory}/plan.json`, JSON.stringify(plan, null, 2));
  for (const [id, c] of Object.entries(cases))
    await writeFile(
      `${directory}/${id}-request.json`,
      JSON.stringify(c.request, null, 2)
    );
  await writeFile(
    `${directory}/source-targets.json`,
    JSON.stringify(cases.B.targets, null, 2)
  );
  console.log(
    JSON.stringify({ ...plan, prepared: true, live: args.includes("--run") })
  );
  if (!args.includes("--run")) return;
  if (!args.includes("--project") || !args.includes("--key-resource"))
    throw new Error("Explicit --project and --key-resource required");
  const { stdout } = await promisify(execFile)(
    "gcloud",
    [
      "services",
      "api-keys",
      "get-key-string",
      arg("--key-resource"),
      "--project=" + arg("--project"),
      "--format=value(keyString)",
      "--quiet",
    ],
    { maxBuffer: 65536 }
  );
  const apiKey = stdout.trim();
  if (!apiKey) throw new Error("Existing key unavailable");
  const summaries = [];
  for (const label of plan.order) {
    const result = await generate(cases[label[0]], apiKey, label, directory);
    const {
      outputText,
      analysis: { translated, ...analysis },
      ...summary
    } = result;
    summaries.push({ ...summary, analysis });
    await writeFile(
      `${directory}/summary.json`,
      JSON.stringify(summaries, null, 2)
    );
    if (result.http !== 200 || result.error || result.status !== "completed")
      break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
