// Experiments only. Freeze all candidates before any explicit live run.
import { readFile, writeFile, mkdir, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { captureCurrent } from "./reproduce-current.mjs";
import { generate } from "./compare-formats.mjs";
import { buildKeyedTask, taskIssue } from "../../keyed-translations.js";
const exec = promisify(execFile);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const referencePattern = () =>
  /\[\d+(?:\s*[-–—]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)*\]/g;
const references = (text) =>
  [...text.matchAll(referencePattern())].map((match) => match[0]);
const markerPattern = () => /\[\[REF_[a-f0-9]+\]\]/g;

export async function citationVariants(pages) {
  const baseline = await captureCurrent(pages);
  const candidates = { B: { ...baseline, citationMode: "baseline" } };
  for (const [code, mode] of [
    ["P", "explicit"],
    ["M", "markers"],
  ]) {
    const candidate = structuredClone(baseline);
    candidate.name = "citation-" + mode;
    candidate.citationMode = mode;
    candidate.markers = {};
    const masked = new Map();
    if (mode === "markers")
      for (const page of pages)
        for (const block of page.blocks) {
          let index = 0;
          masked.set(
            block.id,
            block.text.replace(referencePattern(), (reference) => {
              let length = 10,
                marker;
              const digest = sha(`${block.id}:${index++}:${reference}`);
              do {
                marker = `[[REF_${digest.slice(0, length++)}]]`;
              } while (
                candidate.markers[marker] ||
                pages.some((p) => p.blocks.some((b) => b.text.includes(marker)))
              );
              candidate.markers[marker] = reference;
              return marker;
            })
          );
        }
    const input = JSON.parse(candidate.request.input);
    for (let p = 0; p < input.pages.length; p++)
      for (let b = 0; b < input.pages[p].blocks.length; b++) {
        if (mode === "markers")
          input.pages[p].blocks[b].text = masked.get(pages[p].blocks[b].id);
      }
    candidate.request.input = JSON.stringify(input);
    candidate.request.system_instruction +=
      "\n- For each target, obey the reference inventory in its property description. Preserve each listed reference exactly once at its source claim, in the same order. Do not borrow, remove, duplicate, or invent references. This also applies to text split across columns or pages.\n" +
      (mode === "markers"
        ? "- [[REF_...]] strings are protected opaque reference tokens. Copy them byte for byte inside the translated text at the corresponding claim. Do not translate them or replace them with numbers. A local decoder restores the original reference; never perform that restoration yourself."
        : "- Citation numbers identify specific bibliography entries. Translate the prose, never the reference numbers.");
    for (const target of candidate.targets) {
      const text = mode === "markers" ? masked.get(target.id) : target.text;
      const inventory =
        mode === "markers"
          ? [...text.matchAll(markerPattern())].map((m) => m[0])
          : references(text);
      candidate.request.response_format.schema.properties[
        target.wire
      ].description =
        `Translate this ${target.kind || "paragraph"} from English into Japanese. Exact source to translate: ${JSON.stringify(text)}. Do not add content from other blocks. ` +
        `Required ${mode === "markers" ? "protected reference tokens" : "citation strings"} in this value, each once in this order: ${JSON.stringify(inventory)}. ` +
        (inventory.length
          ? "Copy them at their corresponding source claims without omission or substitution."
          : "This value must not acquire any references from surrounding blocks.");
      if (mode === "markers") target.maskedText = text;
    }
    candidates[code] = candidate;
  }
  return candidates;
}

export function restoreCitations(candidate, translated) {
  const restored = {},
    failures = [];
  for (const target of candidate.targets) {
    const text = translated?.[target.id];
    if (typeof text !== "string") continue;
    if (candidate.citationMode !== "markers") {
      restored[target.id] = text;
      continue;
    }
    const expected = [...target.maskedText.matchAll(markerPattern())].map(
      (m) => m[0]
    );
    const found = [...text.matchAll(markerPattern())].map((m) => m[0]);
    const valid = JSON.stringify(expected) === JSON.stringify(found);
    const decoded = text.replace(
      markerPattern(),
      (marker) => candidate.markers[marker] ?? marker
    );
    // Allow literal double brackets only when they already occur in the source.
    let remainder = decoded;
    for (const literal of target.text.match(/\[\[[\s\S]*?\]\]/g) || [])
      remainder = remainder.replace(literal, "");
    if (!valid || /\[\[|\]\]|REF[_-]/i.test(remainder)) {
      failures.push({
        id: target.id,
        page: target.page,
        expected: expected.length,
        received: found.length,
      });
      continue; // Never append missing references or guess where they belong.
    }
    restored[target.id] = decoded;
  }
  return { translated: restored, markerFailures: failures };
}

export async function citationMetrics(pages, candidate, result) {
  const restored = restoreCitations(candidate, result.analysis.translated);
  const task = await buildKeyedTask(
    pages,
    candidate.targets.map((b) => b.id),
    "English",
    "Japanese"
  );
  const values = new Map(
    [...task.byKey]
      .filter(([, b]) => Object.hasOwn(restored.translated, b.id))
      .map(([key, b]) => [key, restored.translated[b.id]])
  );
  const issues = [...task.byKey].flatMap(([key, b]) => {
    const reason = values.has(key)
      ? taskIssue(task, key, values, "English", "Japanese")
      : "missing";
    return reason
      ? [
          {
            id: b.id,
            page: candidate.targets.find((t) => t.id === b.id).page,
            reason,
          },
        ]
      : [];
  });
  return {
    structuralPass: result.analysis.valid === true,
    markerFailures: restored.markerFailures,
    issues,
    guardPass:
      result.analysis.valid === true &&
      !restored.markerFailures.length &&
      !issues.length,
    translated: restored.translated,
  };
}

export async function verifyPriorCalls(directory) {
  for (const name of (await readdir(directory)).filter((file) =>
    /^[BPM][123]\.started$/.test(file)
  )) {
    const result = JSON.parse(
      await readFile(
        `${directory}/${name.replace(".started", ".json")}`,
        "utf8"
      )
    );
    if (result.http !== 200 || result.error || result.status !== "completed")
      throw new Error(
        "A prior transport/API failure stops the whole experiment"
      );
  }
}

async function main() {
  const args = process.argv.slice(2),
    arg = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--directory")) throw new Error("--directory required");
  const directory = arg("--directory");
  if (args.includes("--prepare")) {
    for (const flag of ["--input", "--baseline-plan"])
      if (!args.includes(flag)) throw new Error(flag + " required");
    const source = await readFile(arg("--input"), "utf8"),
      pages = JSON.parse(source);
    const old = JSON.parse(await readFile(arg("--baseline-plan"), "utf8"));
    if (sha(source) !== old.inputSha256)
      throw new Error("Frozen source differs");
    const candidates = await citationVariants(pages);
    const extra = [
      "p5-b3",
      "p5-b25",
      "p5-b41",
      "p5-b57",
      "p6-b3",
      "p6-b17",
      "p6-b36",
      "p6-b47",
      "p3-b0",
      "p13-b5",
      "p16-b15",
      "p16-b16",
    ];
    const panel = [...new Set([...old.semanticPanel, ...extra])];
    if (panel.some((id) => !candidates.B.targets.some((t) => t.id === id)))
      throw new Error("Fixed panel target missing");
    const plan = {
      recordedAt: (await exec("date", ["+%Y-%m-%dT%H:%M:%S%z"])).stdout.trim(),
      source: old.source,
      project: "gen-lang-client-0097090168",
      model: candidates.B.request.model,
      inputSha256: sha(source),
      pages: pages.length,
      targets: candidates.B.targets.length,
      maximumGenerationRequests: 5,
      initialOrder: ["B1", "P1", "M1"],
      retries: 0,
      automaticRepairs: 0,
      semanticPanel: panel,
      requestSha256: Object.fromEntries(
        Object.entries(candidates).map(([c, v]) => [
          c,
          sha(JSON.stringify(v.request)),
        ])
      ),
      primary:
        "All targets present, production citation/heading guard passes, exact ordered marker inventory if used, and fixed-panel manual source scope/fidelity pass. Never equate key coverage or marker presence with semantic accuracy.",
      selection:
        "After B1/P1/M1, select a P or M candidate only if guard and manual panel pass and total latency <=1.25*B1. Prefer lower latency; then lower output tokens. Lock one selection and repeat it twice without changes. If neither qualifies, stop without confirmations.",
      stopping:
        "Stop all on HTTP/transport/incomplete failures. A failed candidate is not tuned or repeated. Stop confirmations at first guard/manual failure. No model/endpoint/key/billing changes or automatic repairs.",
      firstItemMs:
        "unmeasured by shared keyed collector; compare total latency and first text only",
    };
    await mkdir(directory);
    await writeFile(`${directory}/pages.json`, source);
    await writeFile(`${directory}/candidates.json`, JSON.stringify(candidates));
    await writeFile(`${directory}/plan.json`, JSON.stringify(plan, null, 2));
    console.log(JSON.stringify(plan));
    return;
  }
  for (const flag of ["--run", "--label", "--project", "--key-resource"])
    if (!args.includes(flag))
      throw new Error(flag + " required for explicit execution");
  const plan = JSON.parse(await readFile(`${directory}/plan.json`, "utf8"));
  if (arg("--project") !== plan.project)
    throw new Error("Frozen project differs");
  const candidates = JSON.parse(
    await readFile(`${directory}/candidates.json`, "utf8")
  );
  const source = await readFile(`${directory}/pages.json`, "utf8"),
    pages = JSON.parse(source);
  if (sha(source) !== plan.inputSha256)
    throw new Error("Frozen source changed");
  const label = arg("--label"),
    initialIndex = plan.initialOrder.indexOf(label);
  await verifyPriorCalls(directory);
  let code = label[0],
    previous;
  if (initialIndex >= 0) previous = plan.initialOrder[initialIndex - 1];
  else {
    if (!/^[PM][23]$/.test(label)) throw new Error("Unknown label");
    const selected = JSON.parse(
      await readFile(`${directory}/selection.json`, "utf8")
    );
    if (selected.code !== code)
      throw new Error("Candidate differs from frozen selection");
    const first = JSON.parse(
      await readFile(`${directory}/${code}1-summary.json`, "utf8")
    );
    const base = JSON.parse(
      await readFile(`${directory}/B1-summary.json`, "utf8")
    );
    if (!first.guardPass || first.timing.totalMs > base.timing.totalMs * 1.25)
      throw new Error("Candidate did not qualify");
    previous = code + (Number(label[1]) - 1);
    await readFile(`${directory}/M1-summary.json`, "utf8");
  }
  if (previous) {
    const raw = await readFile(`${directory}/${previous}.json`, "utf8"),
      result = JSON.parse(raw);
    if (result.http !== 200 || result.error || result.status !== "completed")
      throw new Error("Previous transport/API failure stops this experiment");
    if (initialIndex < 0) {
      const summary = JSON.parse(
        await readFile(`${directory}/${previous}-summary.json`, "utf8")
      );
      const review = JSON.parse(
        await readFile(`${directory}/${previous}-review.json`, "utf8")
      );
      if (
        !summary.guardPass ||
        review.gate !== "pass" ||
        review.rawSha256 !== sha(raw) ||
        review.requestSha256 !== plan.requestSha256[code]
      )
        throw new Error("Previous guard/manual gate failed");
    }
  }
  const candidate = candidates[code];
  if (sha(JSON.stringify(candidate.request)) !== plan.requestSha256[code])
    throw new Error("Frozen request changed");
  if (
    (await readdir(directory)).filter((name) =>
      /^[BPM][123]\.started$/.test(name)
    ).length >= plan.maximumGenerationRequests
  )
    throw new Error("Five-call experiment budget exhausted");
  const lock = await open(`${directory}/${label}.started`, "wx");
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
  const result = await generate(candidate, key, label, directory);
  const metrics = await citationMetrics(pages, candidate, result);
  const { translated, ...checks } = metrics;
  const summary = {
    label,
    requestSha256: plan.requestSha256[code],
    rawSha256: sha(await readFile(`${directory}/${label}.json`, "utf8")),
    http: result.http,
    status: result.status,
    timing: result.timing,
    usage: result.usage,
    ...checks,
  };
  await writeFile(
    `${directory}/${label}-decoded.json`,
    JSON.stringify(translated)
  );
  await writeFile(
    `${directory}/${label}-summary.json`,
    JSON.stringify(summary, null, 2)
  );
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
