// Bounded comparison of frozen legacy input versus current production extraction/input.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGeminiTranslator, DEFAULT_MODEL } from '../../gemini.js';
import { legacyRequest } from './legacy-format.mjs';
import { generate } from './compare-formats.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const exec = promisify(execFile);
const panel = ['p1-b0','p1-b12','p1-b13','p1-b14','p1-b39','p1-b41','p2-b7','p2-b15','p2-b25','p2-b26','p2-b27','p2-b28','p2-b35','p2-b36','p6-b30','p6-b33','p6-b38','p6-b64','p6-b70','p7-b52'];
const normalized = (text) => text.replace(/[\s\-–—]/g, '').toLowerCase();

export async function productionCase(pages) {
  const targets = pages.flatMap((p) => p.blocks.filter((b) => b.translate).map((b) => ({ ...b, page: p.page })));
  let request;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ translations: targets.map((_b,i) => ({ id: i+1, text: 'fixture' })) }) }] }] });
  };
  try {
    await createGeminiTranslator({ apiKey: 'offline-placeholder', model: DEFAULT_MODEL, sourceLanguage: 'en', targetLanguage: 'ja' }).translateDocument(pages, targets.map((b) => b.id));
  } finally { globalThis.fetch = original; }
  return { name: 'logical-paragraphs-separated-targets', protocol: 'sequential-flat', request, targets: targets.map((b,i) => ({ ...b, wire: i+1 })) };
}

export function mapPanel(baseline, candidate) {
  return panel.map((id) => {
    const source = baseline.find((b) => b.id === id);
    const exact = candidate.filter((b) => b.page === source?.page && normalized(b.text) === normalized(source.text));
    const matches = exact.length ? exact : candidate.filter((b) => b.page === source?.page && normalized(b.text).includes(normalized(source.text)));
    return { original: id, candidate: matches.length === 1 ? matches[0].id : null, matches: matches.length };
  });
}

async function main() {
  const args = process.argv.slice(2), arg = (name) => args[args.indexOf(name)+1];
  for (const name of ['--baseline-input','--input','--output']) if (!args.includes(name)) throw new Error('Required: --baseline-input old-pages.json --input revised-pages.json --output new-directory');
  const directory = arg('--output');
  // Exclusive creation prevents overwriting a plan or repeating a partially run experiment.
  await mkdir(directory);
  const [oldRaw,newRaw] = await Promise.all([readFile(arg('--baseline-input'),'utf8'),readFile(arg('--input'),'utf8')]);
  const oldPages = JSON.parse(oldRaw), pages = JSON.parse(newRaw);
  const oldTargets = oldPages.flatMap((p) => p.blocks.filter((b) => b.translate).map((b) => ({ ...b,page:p.page })));
  const cases = {
    A: { name: 'sequential-flat', request: legacyRequest(oldPages,oldTargets.map((b) => b.id)), targets: oldTargets.map((b,i) => ({ ...b,wire:i+1 })) },
    C: await productionCase(pages),
  };
  const plan = {
    recordedAt: (await exec('date',['+%Y-%m-%dT%H:%M:%S%z'])).stdout.trim(), model: DEFAULT_MODEL,
    order: ['A1','C1','C2','A2'], maximumGenerationRequests: 4, retries: 0,
    changes: 'Coordinate-based reading order, mixed-style logical paragraphs, preserved line-end hyphens, semantic hints, full reference pages separate from target list. Combined change; effects are not separately identified.',
    inputs: { A: sha(oldRaw), C: sha(newRaw) }, pages: pages.length,
    semanticPanel: mapPanel(cases.A.targets,cases.C.targets),
    primary: 'ID coverage, duplicate/unknown IDs and manual source-scope alignment on the fixed panel, including merged caption and inline-heading targets.',
    secondary: 'Time to first complete item, total latency, input/output tokens. No speed-only acceptance; one paper with two repeats per variant is preliminary.',
    stopping: 'Four calls maximum with no retries. Stop on HTTP/transport errors or absent completion. No prompt changes after results.',
    requests: Object.fromEntries(Object.entries(cases).map(([key,value]) => [key,{ sha256:sha(JSON.stringify(value.request)),targets:value.targets.length,inputChars:value.request.input.length }]))
  };
  if (plan.semanticPanel.some((p) => !p.candidate)) throw new Error('Semantic panel could not be mapped unambiguously; inspect extraction offline before inference');
  await writeFile(`${directory}/plan.json`,JSON.stringify(plan,null,2));
  for (const [key,value] of Object.entries(cases)) {
    await writeFile(`${directory}/${key}-request.json`,JSON.stringify(value.request,null,2));
    await writeFile(`${directory}/${key}-targets.json`,JSON.stringify(value.targets,null,2));
  }
  console.log(JSON.stringify({...plan,live:args.includes('--run')}));
  if (!args.includes('--run')) return;
  if (!args.includes('--project') || !args.includes('--key-resource')) throw new Error('Explicit --project and --key-resource required');
  const {stdout} = await exec('gcloud',['services','api-keys','get-key-string',arg('--key-resource'),'--project='+arg('--project'),'--format=value(keyString)','--quiet'],{maxBuffer:65536});
  const apiKey = stdout.trim();
  if (!apiKey) throw new Error('Existing key unavailable');
  const summary = [];
  for (const label of plan.order) {
    const result = await generate(cases[label[0]],apiKey,label,directory);
    const {outputText,analysis:{translated,...analysis},...rest} = result;
    summary.push({...rest,analysis});
    await writeFile(`${directory}/summary.json`,JSON.stringify(summary,null,2));
    if (result.http !== 200 || result.error || result.status !== 'completed') break;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message);process.exitCode=1; });
