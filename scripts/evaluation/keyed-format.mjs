// Evaluation only: a required translation property for every opaque source key.
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { captureCurrent, citationDiagnostics } from './reproduce-current.mjs';
import { generate } from './compare-formats.mjs';
const exec = promisify(execFile);
const sha = (text) => createHash('sha256').update(text).digest('hex');

export async function keyedCase(pages, { sourceBound = false, taskBound = false } = {}) {
  const current = await captureCurrent(pages,{format:'legacy'}), keys = new Map(), used = new Set();
  const targets = current.targets.map((block) => {
    let length = 6, wire;
    do { wire = sha(block.id).slice(0, length++); } while (used.has(wire));
    used.add(wire); keys.set(block.wire, wire);
    return { ...block, wire };
  });
  const request = structuredClone(current.request), input = JSON.parse(request.input);
  for (const page of input.pages) for (const block of page.blocks) {
    if (block.translate_id !== undefined) block.translate_id = keys.get(block.translate_id);
  }
  request.input = JSON.stringify(input);
  request.system_instruction = request.system_instruction
    .replace(/^The user sends.*$/m, 'The user sends a JSON object whose "pages" array contains all PDF text blocks in reading order. Every block has "text". A block with a string "translate_id" is a target to translate from English into Japanese; blocks without "translate_id" are reference context only. Target identifiers are opaque labels, not numbers. "translate_count" is the total number of targets.')
    .replace(/^- Return a JSON object.*$/m, '- Return one JSON object mapping each target identifier directly to its translated string, for example {"a3c9f1": "translated text", "c2a481": "another translation"}. Each required property belongs only to the input block whose "translate_id" exactly matches that property name. Preserve every identifier and return exactly one nonempty translation for each. Never merge, split, renumber, skip or substitute blocks. Use the entire paper to understand a sentence that continues across blocks or pages, but translate only the source content of the matching block. Do not complete its sentence using source content from another block. Never output reference-only blocks.')
    .replace(/^- Every "text" value.*$/m, '- Every translation value must be written in Japanese; copy the property keys unchanged. Never return English source unchanged except blocks consisting only of names, numbers or formulas.');
  request.response_format.schema = {
    type: 'object', properties: Object.fromEntries(targets.map((b) => [b.wire, {
      type: 'string',
      ...(sourceBound ? { description: taskBound
        ? `Translate this ${b.kind || 'paragraph'} from English into Japanese. Exact source to translate: ${JSON.stringify(b.text)}. Do not add content from other blocks.`
        : `Exact source for this value; do not complete it from context: ${JSON.stringify(b.text)}` } : {}),
    }])),
    required: targets.map((b) => b.wire), additionalProperties: false,
  };
  return { name: taskBound ? 'task-bound-required-property' : sourceBound ? 'source-bound-required-property' : 'required-opaque-property', protocol: 'keyed-object', request, targets };
}

async function main() {
  const args = process.argv.slice(2), arg = (name) => args[args.indexOf(name) + 1];
  if (!args.includes('--directory')) throw new Error('--directory new-or-prepared-directory required');
  const directory = arg('--directory');
  if (args.includes('--prepare')) {
    if (!args.includes('--input') || !args.includes('--baseline-plan')) throw new Error('--prepare requires --input and --baseline-plan');
    const input = await readFile(arg('--input'), 'utf8');
    const taskBound = args.includes('--task-bound'), sourceBound = taskBound || args.includes('--source-bound');
    const candidate = await keyedCase(JSON.parse(input), { sourceBound, taskBound });
    const prior = JSON.parse(await readFile(arg('--baseline-plan'), 'utf8'));
    if (sha(input) !== prior.inputSha256) throw new Error('Frozen source extraction differs');
    const plan = {
      recordedAt: (await exec('date', ['+%Y-%m-%dT%H:%M:%S%z'])).stdout.trim(), model: candidate.request.model,
      inputSha256: sha(input), requestSha256: sha(JSON.stringify(candidate.request)),
      source: prior.source, pages: prior.pages, targets: candidate.targets.length,
      semanticPanel: prior.semanticPanel, order: taskBound ? ['T1', 'T2', 'T3'] : sourceBound ? ['S1', 'S2', 'S3'] : ['K1', 'K2', 'K3'], maximumGenerationRequests: 3, retries: 0,
      variant: candidate.name,
      sourceBound,
      taskBound,
      hypothesis: 'Required opaque translation properties avoid sequential renumbering/omission while retaining one full-document request.',
      gate: 'Every run must complete and have exact key coverage; manually compare the fixed source/translation panel, including cross-column sentence scope and Table 3/4 captions. Any confirmed scope merge, substitution or untranslated ordinary text fails promotion. Citation flags require inspection and are not a semantic score.',
      stopping: 'Stop on HTTP/transport/coverage failure or a failed semantic gate. Do not tune this candidate after results. Only a recorded passing semantic review permits the next call.',
    };
    await mkdir(directory);
    await writeFile(`${directory}/plan.json`, JSON.stringify(plan, null, 2));
    await writeFile(`${directory}/candidate.json`, JSON.stringify(candidate, null, 2));
    console.log(JSON.stringify(plan)); return;
  }
  if (!args.includes('--run') || !args.includes('--label') || !args.includes('--project') || !args.includes('--key-resource')) throw new Error('--run --label K1/K2/K3 --project ID --key-resource RESOURCE required');
  const plan = JSON.parse(await readFile(`${directory}/plan.json`, 'utf8'));
  const candidate = JSON.parse(await readFile(`${directory}/candidate.json`, 'utf8'));
  if (sha(JSON.stringify(candidate.request)) !== plan.requestSha256) throw new Error('Frozen request changed');
  const label = arg('--label'), index = plan.order.indexOf(label);
  if (index < 0) throw new Error('Unknown run label');
  if (index) {
    const previous = plan.order[index - 1];
    const raw = await readFile(`${directory}/${previous}.json`, 'utf8'), result = JSON.parse(raw);
    const review = JSON.parse(await readFile(`${directory}/${previous}-review.json`, 'utf8'));
    if (review.gate !== 'pass' || result.http !== 200 || result.status !== 'completed' || result.error
      || !result.analysis.valid || review.requestSha256 !== plan.requestSha256 || review.rawResultSha256 !== sha(raw)) {
      throw new Error('The preceding run did not pass both structural and semantic gates');
    }
  }
  const lock = await open(`${directory}/${label}.started`, 'wx'); await lock.close();
  const { stdout } = await exec('gcloud', ['services', 'api-keys', 'get-key-string', arg('--key-resource'), '--project=' + arg('--project'), '--format=value(keyString)', '--quiet'], { maxBuffer: 65536 });
  const key = stdout.trim(); if (!key) throw new Error('Existing key unavailable');
  const result = await generate(candidate, key, label, directory);
  const { outputText, analysis: { translated, ...analysis }, ...rest } = result;
  const summary = { ...rest, analysis, citationDiagnostics: citationDiagnostics(candidate, result) };
  await writeFile(`${directory}/${label}-summary.json`, JSON.stringify(summary, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
