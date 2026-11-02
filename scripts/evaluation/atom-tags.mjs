// Offline preparation; one explicitly selected live request, no retries/repair.
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createAtomTagGeminiTranslator } from "../../atom-tag-translations.js";
import { MissingTranslationsError, DEFAULT_MODEL } from "../../gemini.js";
import { generate, analyze } from "./compare-formats.mjs";
const exec = promisify(execFile),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const options = {
  apiKey: "offline-fixture",
  model: DEFAULT_MODEL,
  sourceLanguage: "en",
  targetLanguage: "ja",
};
const files = [
  "atom-tag-translations.js",
  "node-translations.js",
  "protected-translator.js",
  "protected-spans.js",
  "keyed-translations.js",
  "gemini.js",
  "api-error.js",
  "json-members.js",
  "translation-stream.js",
  "scripts/evaluation/compare-formats.mjs",
  "scripts/evaluation/atom-tags.mjs",
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

export async function captureAtomTags(pages) {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    const output = Object.fromEntries(
      JSON.parse(request.input).pages.flatMap((p) =>
        p.blocks
          .filter((b) => b.translate_id)
          .map((b) => [b.translate_id, b.text + " 検証用"])
      )
    );
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
  try {
    await createAtomTagGeminiTranslator(options).translateDocument(
      pages,
      pages.flatMap((p) => p.blocks.filter((b) => b.translate).map((b) => b.id))
    );
  } finally {
    globalThis.fetch = original;
  }
  const input = JSON.parse(request.input),
    targets = [],
    originals = [];
  for (let p = 0; p < pages.length; p++)
    for (let i = 0; i < pages[p].blocks.length; i++) {
      const b = pages[p].blocks[i];
      if (!b.translate) continue;
      const encoded = input.pages[p].blocks[i];
      (encoded.translate_id ? targets : originals).push({
        ...b,
        page: pages[p].page,
        ...(encoded.translate_id
          ? {
              wire: encoded.translate_id,
              sourceAtoms: encoded.original_atoms || [],
            }
          : {}),
      });
    }
  return {
    name: "opaque-original-atom-tags",
    protocol: "keyed-object",
    timeoutMs: 150000,
    request,
    targets,
    originals,
  };
}

export async function replayAtomTags(pages, result) {
  const original = globalThis.fetch;
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
    const out = await createAtomTagGeminiTranslator(options).translateDocument(
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
      issues: e.issues,
    };
  } finally {
    globalThis.fetch = original;
  }
}

async function main() {
  const args = process.argv.slice(2),
    arg = (n) => args[args.indexOf(n) + 1];
  if (!args.includes("--directory")) throw new Error("--directory required");
  const dir = arg("--directory");
  if (args.includes("--prepare")) {
    if (!args.includes("--input") || !args.includes("--panel-plan"))
      throw new Error("--input and --panel-plan required");
    const source = await readFile(arg("--input"), "utf8"),
      pages = JSON.parse(source),
      previous = JSON.parse(await readFile(arg("--panel-plan"), "utf8"));
    if (sha(source) !== previous.inputSha256)
      throw new Error("Fixed source panel differs");
    const candidate = await captureAtomTags(pages),
      counts = {};
    for (const t of candidate.targets)
      for (const a of t.sourceAtoms) counts[a.kind] = (counts[a.kind] || 0) + 1;
    const plan = {
      recordedAt: (await exec("date", ["+%Y-%m-%dT%H:%M:%S%z"])).stdout.trim(),
      source: previous.source,
      sourcePdfSha256: previous.sourcePdfSha256,
      model: DEFAULT_MODEL,
      project: previous.project,
      inputSha256: sha(source),
      requestSha256: sha(JSON.stringify(candidate.request)),
      implementationSha256: await implementationHash(),
      maximumGenerationRequests: 1,
      retries: 0,
      automaticRepairs: 0,
      maximumTotalMs: 150000,
      format: candidate.name,
      targets: candidate.targets.length + candidate.originals.length,
      generatedTargets: candidate.targets.length,
      originalIds: candidate.originals.map((b) => b.id),
      atomCounts: counts,
      semanticPanel: previous.semanticPanel,
      primary:
        "All generated blocks must pass the real decoder, with exact atom inventories and no copied identifiers, formulas or unchanged explanatory captions. Every frozen semantic-panel item must retain the source claim, negation, conditions, comparison, variable/model relationships, and its physical source boundary. Tags and exact key counts do not establish semantic fidelity. Original retention is not translated coverage.",
      stopping:
        "One exploratory call only. Stop on any transport/completion/structural/decoder/coverage/latency/independent semantic failure. No retries, repairs, posthoc source-slot guessing, model judge, prompt changes or promotion based on partial coverage. No browser operation or viewer-default change.",
    };
    await mkdir(dir);
    await writeFile(dir + "/pages.json", source);
    await writeFile(dir + "/candidate.json", JSON.stringify(candidate));
    await writeFile(dir + "/plan.json", JSON.stringify(plan, null, 2));
    console.log(JSON.stringify(plan));
    return;
  }
  for (const n of ["--run", "--project", "--key-resource"])
    if (!args.includes(n)) throw new Error(n + " required");
  const plan = JSON.parse(await readFile(dir + "/plan.json", "utf8")),
    candidate = JSON.parse(await readFile(dir + "/candidate.json", "utf8")),
    source = await readFile(dir + "/pages.json", "utf8"),
    pages = JSON.parse(source);
  if (
    plan.project !== arg("--project") ||
    sha(source) !== plan.inputSha256 ||
    sha(JSON.stringify(candidate.request)) !== plan.requestSha256 ||
    (await implementationHash()) !== plan.implementationSha256
  )
    throw new Error("Frozen experiment differs");
  if (
    sha(JSON.stringify((await captureAtomTags(pages)).request)) !==
    plan.requestSha256
  )
    throw new Error("Factory differs from frozen request");
  const lock = await open(dir + "/T1.started", "wx");
  await lock.close();
  const { stdout } = await exec("gcloud", [
    "services",
    "api-keys",
    "get-key-string",
    arg("--key-resource"),
    "--project=" + plan.project,
    "--format=value(keyString)",
    "--quiet",
  ]);
  const key = stdout.trim();
  if (!key) throw new Error("Existing key unavailable");
  const result = await generate(candidate, key, "T1", dir, analyze),
    decoded = await replayAtomTags(pages, result);
  const originals = Object.entries(decoded.translated)
    .filter(([, v]) => v === null)
    .map(([id]) => id)
    .sort();
  const gate =
    result.http === 200 &&
    !result.error &&
    result.status === "completed" &&
    result.analysis.valid &&
    decoded.accepted &&
    Object.keys(decoded.translated).length === plan.targets &&
    JSON.stringify(originals) ===
      JSON.stringify([...plan.originalIds].sort()) &&
    result.timing.totalMs <= plan.maximumTotalMs;
  const summary = {
    requestSha256: plan.requestSha256,
    rawSha256: sha(await readFile(dir + "/T1.json")),
    http: result.http,
    status: result.status,
    timing: result.timing,
    usage: result.usage,
    structuralPass: result.analysis.valid,
    nodePass: decoded.accepted,
    retained: Object.keys(decoded.translated).length,
    originalIds: originals,
    issues: decoded.issues.map(({ id, reason }) => ({ id, reason })),
    gate,
  };
  const root = (() => {
    try {
      return JSON.parse(result.outputText);
    } catch {
      return {};
    }
  })();
  const panel = plan.semanticPanel.map((id) => {
    const t = [...candidate.targets, ...candidate.originals].find(
      (b) => b.id === id
    );
    return {
      id,
      source: t.text,
      kind: t.kind,
      rawValue: root[t.wire] ?? null,
      accepted: typeof decoded.translated[id] === "string",
      translated: decoded.translated[id] ?? null,
      originalFallback: decoded.translated[id] === null,
    };
  });
  await writeFile(dir + "/T1-decoded.json", JSON.stringify(decoded));
  await writeFile(dir + "/T1-summary.json", JSON.stringify(summary, null, 2));
  await writeFile(dir + "/T1-panel.json", JSON.stringify(panel, null, 2));
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
