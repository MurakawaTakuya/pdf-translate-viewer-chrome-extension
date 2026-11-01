// Reproduce the current viewer request unchanged. Offline preparation is the default.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGeminiTranslator, createKeyedGeminiTranslator, DEFAULT_MODEL } from '../../gemini.js';
import { generate } from './compare-formats.mjs';
const exec = promisify(execFile);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const options = { sourceLanguage: 'en', targetLanguage: 'ja', model: DEFAULT_MODEL };
const panel = ['p1-b0','p1-b3','p1-b4','p1-b5','p1-b6','p1-b7','p1-b9','p1-b32','p1-b33','p1-b34','p1-b35','p2-b17','p2-b20','p2-b23','p2-b24','p2-b25','p2-b26','p2-b33','p2-b34','p6-b27','p6-b29','p6-b31','p6-b55','p6-b60','p7-b49','p16-b20','p17-b0','p17-b1'];

export async function captureCurrent(pages, { format = 'keyed' } = {}) {
  const targets = pages.flatMap((p) => p.blocks.filter((b) => b.translate).map((b) => ({ ...b, page: p.page })));
  let request;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    const fixture = (b) => 'fixture ' + (b.text.match(/\[\d+(?:\s*,\s*\d+)*\]/g) || []).join(' ');
    const output = format === 'keyed'
      ? Object.fromEntries(request.response_format.schema.required.map((key, i) => [key, fixture(targets[i])]))
      : {translations:targets.map((b,i)=>({id:i+1,text:fixture(b)}))};
    return Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(output)}]}]});
  };
  try {
    const factory = format === 'keyed' ? createKeyedGeminiTranslator : createGeminiTranslator;
    await factory({...options,apiKey:'offline-placeholder'}).translateDocument(pages,targets.map((b)=>b.id));
  } finally { globalThis.fetch = original; }
  const wires = format === 'keyed' ? request.response_format.schema.required : targets.map((_b,i)=>i+1);
  return {name:format === 'keyed'?'current-viewer-keyed':'legacy-viewer-unchanged',protocol:format === 'keyed'?'keyed-object':'sequential-flat',request,targets:targets.map((b,i)=>({...b,wire:wires[i]}))};
}

async function validateWithProduction(pages, ids, result, keyed) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({status:result.status,steps:[{type:'model_output',content:[{type:'text',text:result.outputText}]}]});
  try {
    const factory = keyed ? createKeyedGeminiTranslator : createGeminiTranslator;
    const translations = await factory({...options,apiKey:'offline-placeholder'}).translateDocument(pages,ids);
    return {accepted:true,translations:translations.size};
  } catch (error) { return {accepted:false,name:error.name,message:error.message}; }
  finally { globalThis.fetch = original; }
}

const citations = (text) => [...new Set([...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m)=>m[1].split(',').map(Number)))].sort((a,b)=>a-b);
export function citationDiagnostics(variant, result) {
  return variant.targets.filter((b)=>b.page<=8).flatMap((block)=>{
    const text = result.analysis.translated?.[block.id];
    if (!text) return [];
    const expected=citations(block.text),actual=citations(text);
    const missing=expected.filter((v)=>!actual.includes(v)),extra=actual.filter((v)=>!expected.includes(v));
    return missing.length || extra.length ? [{id:block.id,page:block.page,missing,extra}] : [];
  });
}

async function main() {
  const args=process.argv.slice(2),arg=(name)=>args[args.indexOf(name)+1];
  for(const name of ['--input','--output'])if(!args.includes(name))throw new Error('Required: --input pages.json --output new-directory; --run --project ID --key-resource RESOURCE enables at most three calls');
  const input=await readFile(arg('--input'),'utf8'),pages=JSON.parse(input),directory=arg('--output');
  const variant=await captureCurrent(pages,{format:args.includes('--legacy')?'legacy':'keyed'});
  if(panel.some((id)=>!variant.targets.some((b)=>b.id===id)))throw new Error('The fixed panel is absent from this extraction; inspect offline before inference');
  await mkdir(directory); // Exclusive creation: a stopped run can never silently be replayed.
  const plan={recordedAt:(await exec('date',['+%Y-%m-%dT%H:%M:%S%z'])).stdout.trim(),model:DEFAULT_MODEL,
    source:'https://arxiv.org/pdf/2301.08243',inputSha256:sha(input),requestSha256:sha(JSON.stringify(variant.request)),
    pages:pages.length,targets:variant.targets.length,inputChars:variant.request.input.length,
    order:['R1','R2','R3'],maximumGenerationRequests:3,retries:0,inputOrPromptChanges:false,
    primary:'Inspect the raw translations associated with fixed source IDs: paragraph scope, adjacent-block merging, ID substitution and untranslated text. Structural validity alone does not establish alignment.',
    semanticPanel:panel,diagnostic:'Citation-number differences on pages 1-8 flag possible scope drift; manual source/translation comparison is required.',
    stopping:'Stop on HTTP/transport errors or absent API completion; never retry, split, repair, judge with another model, or tune the prompt in this run.'};
  await writeFile(`${directory}/plan.json`,JSON.stringify(plan,null,2));
  await writeFile(`${directory}/request.json`,JSON.stringify(variant.request,null,2));
  await writeFile(`${directory}/targets.json`,JSON.stringify(variant.targets,null,2));
  console.log(JSON.stringify({...plan,live:args.includes('--run')}));
  if(!args.includes('--run'))return;
  if(!args.includes('--project')||!args.includes('--key-resource'))throw new Error('Explicit --project and --key-resource required');
  const {stdout}=await exec('gcloud',['services','api-keys','get-key-string',arg('--key-resource'),'--project='+arg('--project'),'--format=value(keyString)','--quiet'],{maxBuffer:65536});
  const apiKey=stdout.trim();if(!apiKey)throw new Error('Existing key unavailable');
  const summary=[];
  for(const label of plan.order){
    const result=await generate(variant,apiKey,label,directory);
    const productionValidation=result.http===200&&!result.error ? await validateWithProduction(pages,variant.targets.map((b)=>b.id),result,variant.protocol==='keyed-object') : null;
    const {outputText,analysis:{translated,...analysis},...rest}=result;
    const diagnostics=citationDiagnostics(variant,result);
    summary.push({...rest,analysis,productionValidation,citationDiagnostics:diagnostics});
    await writeFile(`${directory}/summary.json`,JSON.stringify(summary,null,2));
    console.log(JSON.stringify({label,productionValidation,citationScopeFlags:diagnostics.length}));
    if(result.http!==200||result.error||result.status!=='completed')break;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch((error)=>{console.error(error.message);process.exitCode=1;});
