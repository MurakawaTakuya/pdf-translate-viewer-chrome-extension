// Capture and replay the actual multi-request factory. Live execution sends
// each frozen request once; no model judge or automatic repair is involved.
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  createKeyedGeminiTranslator,
  MissingTranslationsError,
  DEFAULT_MODEL,
} from "../../gemini.js";
import { readTranslationStream } from "../../translation-stream.js";
import { readApiError, redactApiError } from "../../api-error.js";
const exec = promisify(execFile),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const options = {
  apiKey: "offline-fixture",
  model: DEFAULT_MODEL,
  sourceLanguage: "en",
  targetLanguage: "ja",
};
const files = [
  "gemini.js",
  "translation-batches.js",
  "keyed-translations.js",
  "api-error.js",
  "translation-stream.js",
  "document-translator.js",
  "viewer.js",
  "pdf-layout.js",
  "translation-scope.js",
  "figure-regions.js",
  "scripts/evaluation/batched-document.mjs",
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
const ids = (pages) =>
  pages.flatMap((p) => p.blocks.filter((b) => b.translate).map((b) => b.id));

export async function captureBatchedDocument(pages) {
  const fetch = globalThis.fetch,
    requests = [];
  globalThis.fetch = async (_url, init) => {
    const r = JSON.parse(init.body);
    requests.push(r);
    const out = Object.fromEntries(
      JSON.parse(r.input).pages.flatMap((p) =>
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
          content: [{ type: "text", text: JSON.stringify(out) }],
        },
      ],
    });
  };
  try {
    await createKeyedGeminiTranslator(options).translateDocument(
      pages,
      ids(pages)
    );
  } finally {
    globalThis.fetch = fetch;
  }
  return requests;
}

async function main() {
  const args = process.argv.slice(2),
    arg = (n) => args[args.indexOf(n) + 1];
  if (!args.includes("--directory")) throw new Error("--directory required");
  const dir = arg("--directory");
  if (args.includes("--prepare")) {
    for (const name of ["--input", "--source", "--project"])
      if (!args.includes(name)) throw new Error(name + " required");
    const source = await readFile(arg("--input"), "utf8"),
      pages = JSON.parse(source),
      requests = await captureBatchedDocument(pages);
    const plan = {
      recordedAt: (await exec("date", ["+%Y-%m-%dT%H:%M:%S%z"])).stdout.trim(),
      source: arg("--source"),
      model: DEFAULT_MODEL,
      project: arg("--project"),
      inputSha256: sha(source),
      implementationSha256: await implementationHash(),
      implementationFiles: files,
      requestHashes: requests.map((r) => sha(JSON.stringify(r))),
      maximumGenerationRequests: requests.length,
      targets: ids(pages).length,
      batches: requests.map((r) => ({
        targets: r.response_format.schema.required.length,
        schemaBytes: Buffer.byteLength(
          JSON.stringify(r.response_format.schema)
        ),
      })),
      deadlineMs: 480000,
      retries: 0,
      automaticRepairs: 0,
      primary:
        "Every planned batch HTTP 200 and completed; source binding, required IDs and existing content checks remain unchanged. Decoder coverage and API acceptance are separate; semantic fidelity is not guaranteed. Report withheld values without rescue.",
      stopping:
        "Send only the exact frozen requests once, in order. Refuse additional or changed requests before network access, including automatic retry/schema fallback. Preserve validated partial results on failure. No API judge or Chrome operation.",
    };
    await mkdir(dir);
    await writeFile(dir + "/pages.json", source);
    await writeFile(dir + "/requests.json", JSON.stringify(requests));
    await writeFile(dir + "/plan.json", JSON.stringify(plan, null, 2));
    console.log(JSON.stringify(plan));
    return;
  }
  for (const name of ["--run", "--project", "--key-resource"])
    if (!args.includes(name)) throw new Error(name + " required");
  const plan = JSON.parse(await readFile(dir + "/plan.json", "utf8")),
    source = await readFile(dir + "/pages.json", "utf8"),
    pages = JSON.parse(source),
    requests = JSON.parse(await readFile(dir + "/requests.json", "utf8"));
  if (
    plan.project !== arg("--project") ||
    sha(source) !== plan.inputSha256 ||
    (await implementationHash()) !== plan.implementationSha256 ||
    JSON.stringify(requests.map((r) => sha(JSON.stringify(r)))) !==
      JSON.stringify(plan.requestHashes)
  )
    throw new Error("Frozen experiment differs");
  if (
    JSON.stringify(
      (await captureBatchedDocument(pages)).map((r) => sha(JSON.stringify(r)))
    ) !== JSON.stringify(plan.requestHashes)
  )
    throw new Error("Factory differs from frozen requests");
  const lock = await open(dir + "/run.started", "wx");
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
  const apiKey = stdout.trim();
  if (!apiKey) throw new Error("Existing key unavailable");
  const fetch = globalThis.fetch,
    started = performance.now(),
    records = [],
    pending = [];
  let translated = new Map(),
    error = null;
  const signal = AbortSignal.timeout(plan.deadlineMs);
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body),
      index = records.length;
    if (
      index >= requests.length ||
      sha(JSON.stringify(request)) !== plan.requestHashes[index]
    )
      throw new Error("Frozen request budget or request identity differs");
    const record = {
      index: index + 1,
      requestSha256: plan.requestHashes[index],
      targets: request.response_format.schema.required.length,
    };
    records.push(record);
    const begin = performance.now(),
      response = await fetch(url, init);
    record.http = response.status;
    pending.push(
      (async () => {
        const copy = response.clone();
        try {
          if (!copy.ok)
            record.error = redactApiError(await readApiError(copy), apiKey);
          else {
            const stream = /text\/event-stream/i.test(
              copy.headers.get("content-type") || ""
            )
              ? await readTranslationStream(copy, { signal })
              : await copy.json().then((body) => ({
                  status: body.status,
                  text: (body.steps || [])
                    .filter((s) => s.type === "model_output")
                    .flatMap((s) => s.content || [])
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join(""),
                }));
            record.status = stream.status;
            record.outputText = stream.text;
            record.outputSha256 = sha(stream.text);
          }
        } catch (e) {
          record.error = redactApiError({ message: e.message }, apiKey);
        } finally {
          record.totalMs = performance.now() - begin;
        }
        await writeFile(
          `${dir}/batch-${record.index}.json`,
          JSON.stringify(record, null, 2)
        );
      })()
    );
    return response;
  };
  const progress = setInterval(
    () =>
      console.log(
        JSON.stringify({
          elapsedSeconds: Math.round((performance.now() - started) / 1000),
          requests: records.length,
          completed: records.filter((r) => r.status === "completed").length,
        })
      ),
    15000
  );
  try {
    const result = await createKeyedGeminiTranslator({
      ...options,
      apiKey,
      signal,
    }).translateDocument(
      pages,
      ids(pages),
      () => {},
      (batch) => {
        for (const [id, text] of batch.translations || [])
          translated.set(id, text);
      }
    );
    for (const [id, text] of result) translated.set(id, text);
  } catch (e) {
    error = { name: e.name, message: e.message };
    if (e instanceof MissingTranslationsError) {
      for (const [id, text] of e.partialTranslations) translated.set(id, text);
      error.issues = e.issues;
      error.missingIds = e.missingIds;
    }
  } finally {
    globalThis.fetch = fetch;
    clearInterval(progress);
    await Promise.allSettled(pending);
  }
  await writeFile(
    dir + "/decoded.json",
    JSON.stringify(Object.fromEntries(translated))
  );
  await writeFile(dir + "/error.json", JSON.stringify(error));
  const summary = {
    recordedAt: (await exec("date", ["+%Y-%m-%dT%H:%M:%S%z"])).stdout.trim(),
    source: plan.source,
    model: plan.model,
    project: plan.project,
    inputSha256: plan.inputSha256,
    requestHashes: plan.requestHashes,
    actualRequests: records.length,
    targets: plan.targets,
    accepted: translated.size,
    missing: plan.targets - translated.size,
    totalMs: performance.now() - started,
    apiAcceptance:
      records.length === requests.length &&
      records.every((r) => r.http === 200 && r.status === "completed"),
    allDecoded: !error && translated.size === plan.targets,
    batches: records.map(({ outputText, ...r }) => r),
    ...(error
      ? {
          error: {
            name: error.name,
            message: error.message,
            issues: error.issues?.map(({ id, reason }) => ({ id, reason })),
          },
        }
      : {}),
  };
  await writeFile(dir + "/summary.json", JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
