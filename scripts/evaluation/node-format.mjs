// Ranked-node experiment. Preparation is offline; previous failed experiments
// remain failed. No model/API calls are made without an explicit --run.
import { readFile, writeFile, mkdir, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createNodeGeminiTranslator } from "../../node-translations.js";
import { createFlatNodeGeminiTranslator } from "../../flat-node-translations.js";
import { createCompactNodeGeminiTranslator } from "../../compact-node-translations.js";
import { strictJson } from "../../json-members.js";
import { MissingTranslationsError, DEFAULT_MODEL } from "../../gemini.js";
import { mapPanel } from "./protected-format.mjs";
import { generate } from "./compare-formats.mjs";
const exec = promisify(execFile),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const options = {
  apiKey: "offline-placeholder",
  sourceLanguage: "en",
  targetLanguage: "ja",
  model: DEFAULT_MODEL,
};
const files = [
  "node-translations.js",
  "flat-node-translations.js",
  "compact-node-translations.js",
  "json-members.js",
  "protected-translator.js",
  "protected-spans.js",
  "pdf-layout.js",
  "gemini.js",
  "api-error.js",
  "keyed-translations.js",
  "document-translator.js",
  "translation-stream.js",
  "viewer.js",
  "viewer.css",
  "export.js",
  "math.js",
  "scripts/evaluation/node-format.mjs",
  "scripts/evaluation/protected-format.mjs",
  "scripts/evaluation/compare-formats.mjs",
];
async function implementationHash() {
  return sha(
    (
      await Promise.all(
        files.map(
          async (f) =>
            f +
            "\n" +
            (await readFile(new URL("../../" + f, import.meta.url), "utf8"))
        )
      )
    ).join("\n")
  );
}

export async function captureNodes(
  pages,
  { flat = false, compact = false } = {}
) {
  if (flat && compact) throw new Error("Choose one node encoding");
  let request;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    const properties = request.response_format.schema.properties;
    const blocks = JSON.parse(request.input)
      .pages.flatMap((p) => p.blocks)
      .filter((b) => b.translate_id);
    const output = {};
    for (const b of blocks) {
      if (compact) {
        const records = [];
        let before = "",
          rank = 0;
        for (const p of b.source_parts) {
          if (p.atom) {
            records.push(`${rank++}:${before}`);
            before = "";
          } else before += p.text;
        }
        output[b.translate_id] = rank
          ? [...records, before + " 検証用"].join("\n")
          : "検証用の訳文";
        continue;
      }
      if (flat) {
        if (b.whole_field) {
          output[b.whole_field] = "検証用の訳文";
          continue;
        }
        let before = "",
          rank = 0;
        for (const p of b.source_parts) {
          if (p.atom) {
            output[p.field] = `${rank++}:${before}`;
            before = "";
          } else before += p.text;
        }
        output[b.tail_field] = before + " 検証用";
        continue;
      }
      if (properties[b.translate_id].type === "string") {
        output[b.translate_id] = "検証用の訳文";
        continue;
      }
      // Synthetic request fixture, not a translation: preserve source adjacency
      // (including author-affiliation superscripts), then add a fixture suffix.
      const value = {};
      let before = "",
        rank = 0;
      for (const part of b.source_parts) {
        if (part.atom) {
          value[part.atom] = { o: rank++, t: before };
          before = "";
        } else before += part.text;
      }
      value.tail = before + " 検証用";
      output[b.translate_id] = value;
    }
    return Response.json({
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(output) }],
        },
      ],
    });
  };
  const ids = pages.flatMap((p) =>
    p.blocks.filter((b) => b.translate).map((b) => b.id)
  );
  try {
    await (
      compact
        ? createCompactNodeGeminiTranslator
        : flat
          ? createFlatNodeGeminiTranslator
          : createNodeGeminiTranslator
    )(options).translateDocument(pages, ids);
  } finally {
    globalThis.fetch = fetch;
  }
  const input = JSON.parse(request.input),
    targets = [],
    originals = [];
  for (let p = 0; p < pages.length; p++)
    for (let i = 0; i < pages[p].blocks.length; i++) {
      const b = pages[p].blocks[i];
      if (!b.translate) continue;
      const encoded = input.pages[p].blocks[i],
        wire = encoded.translate_id;
      (wire ? targets : originals).push({
        ...b,
        page: pages[p].page,
        ...(wire ? { wire, sourceParts: encoded.source_parts } : {}),
      });
    }
  return {
    name: compact
      ? "compact-ranked-original-nodes"
      : flat
        ? "flat-ranked-original-nodes"
        : "ranked-original-nodes",
    protocol: flat ? "flat-node-object" : "node-object",
    request,
    targets,
    originals,
  };
}

export function analyzeNodes(candidate, text, status) {
  try {
    const root = strictJson(text);
    if (!root || typeof root !== "object" || Array.isArray(root))
      throw new Error("root");
    const expected = new Set(
        candidate.protocol === "flat-node-object"
          ? candidate.request.response_format.schema.required
          : candidate.targets.map((t) => t.wire)
      ),
      keys = Object.keys(root);
    const missing = [...expected].filter((k) => !Object.hasOwn(root, k)).length,
      unknown = keys.filter((k) => !expected.has(k)).length;
    return {
      valid:
        status === "completed" &&
        !missing &&
        !unknown &&
        keys.length === expected.size,
      expected: expected.size,
      received: keys.length,
      missing,
      unknown,
    };
  } catch {
    return { valid: false, reason: "invalid-or-duplicate-json" };
  }
}

export async function replayNodes(
  pages,
  result,
  { flat = false, compact = false } = {}
) {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      status: result.status,
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: result.outputText }],
        },
      ],
    });
  try {
    const out = await (
      compact
        ? createCompactNodeGeminiTranslator
        : flat
          ? createFlatNodeGeminiTranslator
          : createNodeGeminiTranslator
    )(options).translateDocument(
      pages,
      pages.flatMap((p) => p.blocks.filter((b) => b.translate).map((b) => b.id))
    );
    return { accepted: true, translated: Object.fromEntries(out), issues: [] };
  } catch (e) {
    if (!(e instanceof MissingTranslationsError))
      return { accepted: false, translated: {}, issues: [], error: e.message };
    return {
      accepted: false,
      translated: Object.fromEntries(e.partialTranslations),
      issues: e.issues.map(({ id, reason }) => ({ id, reason })),
    };
  } finally {
    globalThis.fetch = fetch;
  }
}

async function main() {
  const args = process.argv.slice(2),
    arg = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--directory")) throw new Error("--directory required");
  const dir = arg("--directory");
  if (args.includes("--prepare")) {
    for (const f of ["--input", "--old-input", "--old-plan"])
      if (!args.includes(f)) throw new Error(f + " required");
    const source = await readFile(arg("--input"), "utf8"),
      pages = JSON.parse(source),
      oldSource = await readFile(arg("--old-input"), "utf8"),
      old = JSON.parse(await readFile(arg("--old-plan"), "utf8"));
    if (sha(oldSource) !== old.inputSha256)
      throw new Error("Previous panel source changed");
    const flat = args.includes("--flat"),
      compact = args.includes("--compact"),
      candidate = await captureNodes(pages, { flat, compact }),
      mapping = mapPanel(JSON.parse(oldSource), pages, [
        ...new Set([...old.semanticPanel, "p6-b28", "p7-b51"]),
      ]);
    if (candidate.request.model !== "gemini-3.5-flash-lite")
      throw new Error("User-selected model differs");
    const atomCounts = {};
    for (const t of candidate.targets)
      for (const p of t.sourceParts)
        if (p.atom) atomCounts[p.kind] = (atomCounts[p.kind] || 0) + 1;
    const all = [...candidate.targets, ...candidate.originals];
    const plan = {
      recordedAt: (await exec("date", ["+%Y-%m-%dT%H:%M:%S%z"])).stdout.trim(),
      source: "https://arxiv.org/pdf/2301.08243",
      sourcePdfSha256: old.sourcePdfSha256,
      project: old.project,
      model: DEFAULT_MODEL,
      inputSha256: sha(source),
      requestSha256: sha(JSON.stringify(candidate.request)),
      implementationSha256: await implementationHash(),
      format: compact
        ? "compact-ranked-nodes"
        : flat
          ? "flat-ranked-nodes"
          : "nested-ranked-nodes",
      maximumGenerationRequests: 3,
      order: compact
        ? ["C1", "C2", "C3"]
        : flat
          ? ["F1", "F2", "F3"]
          : ["N1", "N2", "N3"],
      retries: 0,
      automaticRepairs: 0,
      maximumTotalMs: 150000,
      targets: all.length,
      generatedTargets: candidate.targets.length,
      ...(flat
        ? {
            schema:
              "Required shallow root string fields. Atom value is strict ASCII rank:preceding prose; tail/whole roles are local. No nested objects, arrays, numeric types, enums, patterns or bounds in the service schema.",
            requiredFields:
              candidate.request.response_format.schema.required.length,
          }
        : {}),
      ...(compact
        ? {
            schema:
              "One required root string per source block. Exactly k+1 LF-separated records are checked LOCALLY for blocks with k atoms; source-slot order and Japanese rank are separate. No API per-atom fields or count constraints. No LF inside prose; empty final tail must retain trailing LF. Positional source slots introduce semantic attachment risk and require the same independent panel.",
            requiredFields:
              candidate.request.response_format.schema.required.length,
          }
        : {}),
      originalIds: candidate.originals.map((t) => t.id),
      originalChars: candidate.originals.reduce((n, t) => n + t.text.length, 0),
      totalTargetChars: all.reduce((n, t) => n + t.text.length, 0),
      atomCounts,
      panelMapping: mapping,
      semanticPanel: [...new Set(mapping.map((m) => m.current))],
      primary:
        "Actual node parser passes every generated block. Required atom properties are present, o is an exact permutation, no malformed/duplicate/foreign keys, LaTeX, Greek/Unicode Sm operators, markup, C0 other than LF or normalized alphanumeric identifiers in prose. Source atoms are inserted by code; their inventory is NOT a semantic quality score. Every panel item preserves its own claim, atom attachment, variables, model identifiers, conditions, negation and comparative force. Explicitly inspect untagged ASCII formulas and spaced identifier paraphrases. Original retention must equal the frozen IDs and is not translated coverage.",
      latency:
        "Predeclare a 150-second ceiling for this new representation before any live call, versus the previous 113.766-second G1 reference. This allows measurable JSON/node overhead while preserving a finite bound. Do not change it after results. No claimed speed improvement based on one sample.",
      stopping:
        "One candidate, at most three unchanged calls. Stop at the first HTTP/transport/completion/structural/decoder/coverage/latency/independent assistant semantic-review failure. Before confirmations require previous passing reviews bound to raw/request hashes. No retries, repair, schema relaxation, prompt tuning, extra judge calls, model/project/endpoint changes in this run.",
      firstItemMs:
        "Unmeasured by shared collector; firstText and total only. No Chrome automation.",
    };
    await mkdir(dir);
    await writeFile(dir + "/pages.json", source);
    await writeFile(dir + "/candidate.json", JSON.stringify(candidate));
    await writeFile(dir + "/plan.json", JSON.stringify(plan, null, 2));
    console.log(JSON.stringify(plan));
    return;
  }
  for (const f of ["--run", "--label", "--project", "--key-resource"])
    if (!args.includes(f)) throw new Error(f + " required");
  const plan = JSON.parse(await readFile(dir + "/plan.json", "utf8")),
    candidate = JSON.parse(await readFile(dir + "/candidate.json", "utf8")),
    source = await readFile(dir + "/pages.json", "utf8"),
    pages = JSON.parse(source),
    label = arg("--label"),
    index = plan.order.indexOf(label);
  if (
    index < 0 ||
    arg("--project") !== plan.project ||
    sha(source) !== plan.inputSha256 ||
    (await implementationHash()) !== plan.implementationSha256 ||
    sha(JSON.stringify(candidate.request)) !== plan.requestSha256
  )
    throw new Error(
      "Frozen label/project/source/implementation/request differs"
    );
  const flat = plan.format === "flat-ranked-nodes",
    compact = plan.format === "compact-ranked-nodes";
  if (
    sha(
      JSON.stringify((await captureNodes(pages, { flat, compact })).request)
    ) !== plan.requestSha256
  )
    throw new Error("Current factory cannot reproduce frozen request");
  for (const prev of plan.order.slice(0, index)) {
    const summary = JSON.parse(
        await readFile(`${dir}/${prev}-summary.json`, "utf8")
      ),
      review = JSON.parse(await readFile(`${dir}/${prev}-review.json`, "utf8")),
      raw = await readFile(`${dir}/${prev}.json`);
    if (
      !summary.gate ||
      review.gate !== "pass" ||
      review.rawSha256 !== sha(raw) ||
      review.requestSha256 !== plan.requestSha256
    )
      throw new Error("Prior frozen gate failed");
  }
  if (
    (await readdir(dir)).filter((n) => /^[NFC][123]\.started$/.test(n))
      .length >= 3
  )
    throw new Error("Three-call budget exhausted");
  const lock = await open(`${dir}/${label}.started`, "wx");
  await lock.close();
  const { stdout } = await exec(
    "gcloud",
    [
      "services",
      "api-keys",
      "get-key-string",
      arg("--key-resource"),
      "--project=" + plan.project,
      "--format=value(keyString)",
      "--quiet",
    ],
    { maxBuffer: 65536 }
  );
  const key = stdout.trim();
  if (!key) throw new Error("Existing key unavailable");
  const result = await generate(candidate, key, label, dir, analyzeNodes),
    decoded = await replayNodes(pages, result, { flat, compact }),
    originalIds = Object.entries(decoded.translated)
      .filter(([, v]) => v === null)
      .map(([id]) => id)
      .sort();
  const coverage =
    Object.keys(decoded.translated).length === plan.targets &&
    JSON.stringify(originalIds) ===
      JSON.stringify([...plan.originalIds].sort());
  const summary = {
    label,
    requestSha256: plan.requestSha256,
    rawSha256: sha(await readFile(`${dir}/${label}.json`)),
    http: result.http,
    status: result.status,
    timing: result.timing,
    usage: result.usage,
    structuralPass: result.analysis.valid === true,
    nodePass: decoded.accepted,
    coverage,
    originalIds,
    issues: decoded.issues,
    ...(decoded.error ? { error: decoded.error } : {}),
    gate:
      result.http === 200 &&
      !result.error &&
      result.status === "completed" &&
      result.analysis.valid === true &&
      decoded.accepted &&
      coverage &&
      result.timing.totalMs <= plan.maximumTotalMs,
  };
  await writeFile(
    `${dir}/${label}-decoded.json`,
    JSON.stringify(decoded.translated)
  );
  await writeFile(
    `${dir}/${label}-summary.json`,
    JSON.stringify(summary, null, 2)
  );
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
