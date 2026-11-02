// Offline preparation first. A frozen run allows at most three identical calls.
import { readFile, writeFile, mkdir, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createProtectedGeminiTranslator } from '../../protected-translator.js';
import { MissingTranslationsError, DEFAULT_MODEL } from '../../gemini.js';
import { generate } from './compare-formats.mjs';
const exec = promisify(execFile);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const options = { sourceLanguage:'en', targetLanguage:'ja', model:DEFAULT_MODEL, apiKey:'offline-placeholder' };
const implementationFiles = ['protected-translator.js','protected-spans.js','pdf-layout.js','gemini.js','keyed-translations.js','document-translator.js',
  'translation-stream.js','api-error.js','viewer.js','viewer.css','export.js','math.js','scripts/evaluation/protected-format.mjs','scripts/evaluation/compare-formats.mjs'];
async function implementationHash() {
  return sha((await Promise.all(implementationFiles.map(async (path) => path + '\n' + await readFile(new URL('../../' + path,import.meta.url),'utf8')))).join('\n'));
}

export async function captureProtected(pages) {
  let request;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (_url,init) => {
    request = JSON.parse(init.body);
    const blocks = JSON.parse(request.input).pages.flatMap(p=>p.blocks).filter(b=>b.translate_id);
    const fixture = Object.fromEntries(blocks.map(b=>[b.translate_id,'検証用の訳文 ' + (b.protected_spans||[]).map(s=>s.tag).join(' ')]));
    return Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(fixture)}]}]});
  };
  try { await createProtectedGeminiTranslator(options).translateDocument(pages,pages.flatMap(p=>p.blocks.filter(b=>b.translate).map(b=>b.id))); }
  catch (error) { if (!(error instanceof MissingTranslationsError)) throw error; }
  finally { globalThis.fetch = fetch; }
  if (!request) throw new Error('Offline capture did not produce a request');
  const encoded = JSON.parse(request.input), targets = [], originals = [];
  for (let p=0;p<pages.length;p++) for (let b=0;b<pages[p].blocks.length;b++) {
    const block = pages[p].blocks[b]; if (!block.translate) continue;
    const wire = encoded.pages[p].blocks[b].translate_id;
    (wire ? targets : originals).push({...block,page:pages[p].page,...(wire?{wire}:{})});
  }
  return {name:'protected-original-glyphs',protocol:'keyed-object',request,targets,originals};
}

export async function replayProtected(pages,result) {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({status:result.status,steps:[{type:'model_output',content:[{type:'text',text:result.outputText}]}]});
  const ids = pages.flatMap(p=>p.blocks.filter(b=>b.translate).map(b=>b.id));
  try {
    const out = await createProtectedGeminiTranslator(options).translateDocument(pages,ids);
    return {accepted:true,translated:Object.fromEntries(out),issues:[]};
  } catch (error) {
    if (!(error instanceof MissingTranslationsError)) throw error;
    return {accepted:false,translated:Object.fromEntries(error.partialTranslations),issues:error.issues.map(({id,reason})=>({id,reason}))};
  } finally { globalThis.fetch = fetch; }
}

// Preserve the earlier fixed panel's physical source coverage after layout joins.
export function mapPanel(oldPages,pages,ids) {
  return ids.map(id=>{
    const page = oldPages.find(p=>p.blocks.some(b=>b.id===id));
    const old = page?.blocks.find(b=>b.id===id);
    if (!old) throw new Error('Previous panel source absent: ' + id);
    const candidates = pages.find(p=>p.page===page.page).blocks.filter(b=>b.translate);
    const exact = candidates.filter(b=>b.text===old.text);
    if (exact.length===1) return {old:id,current:exact[0].id,method:'exact-source'};
    const [x,y,r,bottom] = old.bbox, area=(r-x)*(bottom-y);
    const covered = candidates.filter(b=>{
      const [a,c,d,e]=b.bbox;
      return Math.max(0,Math.min(r,d)-Math.max(x,a))*Math.max(0,Math.min(bottom,e)-Math.max(y,c))/area>.98;
    });
    if(covered.length!==1) throw new Error('Ambiguous physical panel mapping: '+id);
    return {old:id,current:covered[0].id,method:'source-bbox-containment'};
  });
}

async function main() {
  const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
  if(!args.includes('--directory')) throw new Error('--directory required');
  const directory=arg('--directory');
  if(args.includes('--prepare')) {
    for(const flag of ['--input','--old-input','--old-plan']) if(!args.includes(flag)) throw new Error(flag+' required');
    const source=await readFile(arg('--input'),'utf8'),pages=JSON.parse(source);
    const oldSource=await readFile(arg('--old-input'),'utf8'),old=JSON.parse(await readFile(arg('--old-plan'),'utf8'));
    if(sha(oldSource)!==old.inputSha256) throw new Error('Previous panel extraction changed');
    const candidate=await captureProtected(pages),mapping=mapPanel(JSON.parse(oldSource),pages,old.semanticPanel);
    const targetBlocks=[...candidate.targets,...candidate.originals];
    const plan={recordedAt:(await exec('date',['+%Y-%m-%dT%H:%M:%S%z'])).stdout.trim(),source:'https://arxiv.org/pdf/2301.08243',
      sourcePdfSha256:'eddbdc093eb4d48662bcf4fbd1c6735ccd606205cc9070977ce317d68aff3941',
      project:'gen-lang-client-0097090168',model:DEFAULT_MODEL,inputSha256:sha(source),requestSha256:sha(JSON.stringify(candidate.request)),implementationSha256:await implementationHash(),
      maximumGenerationRequests:3,order:['G1','G2','G3'],retries:0,automaticRepairs:0,maximumTotalMs:131400,
      latencyReference:'Previous unchanged B1: 105.12 seconds; retain 1.25x ceiling (131.4 s). One baseline measurement is not statistical evidence of speed improvement.',
      targets:targetBlocks.length,generatedTargets:candidate.targets.length,originalIds:candidate.originals.map(b=>b.id),
      originalChars:candidate.originals.reduce((n,b)=>n+b.text.length,0),totalTargetChars:targetBlocks.reduce((n,b)=>n+b.text.length,0),
      mathSpans:targetBlocks.reduce((n,b)=>n+(b.mathSpans?.length||0),0),panelMapping:mapping,
      semanticPanel:[...new Set([...mapping.map(m=>m.current),...targetBlocks.filter(b=>b.mathSpans?.length||b.mathUncertain).map(b=>b.id)])],
      primary:'All safe targets must pass the actual protected translator: exact per-block tag multiset, well-formed tags, citation/heading checks, no generated LaTeX, C0 other than LF, Greek or Unicode Sm operators. Original fallbacks must equal the frozen IDs and remain separately counted. Each fixed-panel source/translation must retain its own claims, references, comparative scope and variables. Explicitly inspect untagged ASCII expressions and Unicode subscripts/superscripts: inventory alone is not a semantic guarantee.',
      stopping:'Stop at the first transport, completion, structure, protected decoder, coverage, latency or independent assistant review failure. Before G2/G3 require previous raw/request hashes and a passing review. Never tune, retry, repair, split, change endpoint/model/project, or run a model judge in this experiment.',
      firstItemMs:'Unmeasured for this keyed protocol by the shared collector; firstText and total latency only. Original math uses offline glyph crops, including saved PDF; no additional API calls.'};
    await mkdir(directory);
    await writeFile(directory+'/pages.json',source);
    await writeFile(directory+'/candidate.json',JSON.stringify(candidate));
    await writeFile(directory+'/plan.json',JSON.stringify(plan,null,2));
    console.log(JSON.stringify(plan)); return;
  }
  for(const flag of ['--run','--label','--project','--key-resource']) if(!args.includes(flag)) throw new Error(flag+' required');
  const plan=JSON.parse(await readFile(directory+'/plan.json','utf8'));
  const candidate=JSON.parse(await readFile(directory+'/candidate.json','utf8'));
  const source=await readFile(directory+'/pages.json','utf8'),pages=JSON.parse(source);
  const label=arg('--label'),index=plan.order.indexOf(label);
  if(index<0||arg('--project')!==plan.project||sha(source)!==plan.inputSha256||await implementationHash()!==plan.implementationSha256
    ||sha(JSON.stringify(candidate.request))!==plan.requestSha256) throw new Error('Frozen label/project/source/request/implementation differs');
  const fresh=await captureProtected(pages);
  if(sha(JSON.stringify(fresh.request))!==plan.requestSha256) throw new Error('Current candidate no longer reproduces the frozen request');
  const started=(await readdir(directory)).filter(name=>/^G[123]\.started$/.test(name));
  if(started.length>=plan.maximumGenerationRequests) throw new Error('Three-call budget exhausted');
  for(const previous of plan.order.slice(0,index)) {
    const summary=JSON.parse(await readFile(`${directory}/${previous}-summary.json`,'utf8'));
    const review=JSON.parse(await readFile(`${directory}/${previous}-review.json`,'utf8'));
    const raw=await readFile(`${directory}/${previous}.json`,'utf8');
    if(!summary.gate||review.gate!=='pass'||review.rawSha256!==sha(raw)||review.requestSha256!==plan.requestSha256) throw new Error('A prior run failed its frozen gates');
  }
  const lock=await open(`${directory}/${label}.started`,'wx');await lock.close();
  const {stdout}=await exec('gcloud',['services','api-keys','get-key-string',arg('--key-resource'),'--project='+plan.project,'--format=value(keyString)','--quiet'],{maxBuffer:65536});
  const key=stdout.trim();if(!key)throw new Error('Existing key unavailable');
  const result=await generate(candidate,key,label,directory),decoded=await replayProtected(pages,result);
  const originalIds=Object.entries(decoded.translated).filter(([,text])=>text===null).map(([id])=>id).sort();
  const coverage=Object.keys(decoded.translated).length===plan.targets&&JSON.stringify(originalIds)===JSON.stringify([...plan.originalIds].sort());
  const summary={label,requestSha256:plan.requestSha256,rawSha256:sha(await readFile(`${directory}/${label}.json`)),
    http:result.http,status:result.status,timing:result.timing,usage:result.usage,structuralPass:result.analysis.valid===true,
    protectedPass:decoded.accepted,coverage,originalIds,issues:decoded.issues,
    gate:result.http===200&&!result.error&&result.status==='completed'&&result.analysis.valid===true&&decoded.accepted&&coverage&&result.timing.totalMs<=plan.maximumTotalMs};
  await writeFile(`${directory}/${label}-decoded.json`,JSON.stringify(decoded.translated));
  await writeFile(`${directory}/${label}-summary.json`,JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
