// One service-required string per source block. Atom records are positional
// source slots within that block, with independently validated Japanese ranks.
import { createGeminiTranslator,MissingTranslationsError } from './gemini.js';
import { buildNodeTask } from './node-translations.js';
import { parseRankField } from './flat-node-translations.js';
import { withOriginalFallback } from './protected-translator.js';
import { keyedPrompt } from './keyed-translations.js';
import { jsonMembers } from './json-members.js';

export async function buildCompactNodeTask(pages,ids,src,dst,signal){
  const base=await buildNodeTask(pages,ids,src,dst,signal),properties={};
  for(const [key]of base.byKey){
    const {atoms}=base.layouts.get(key);
    properties[key]={type:'string',description:base.schema.properties[key].description+(atoms.length?
      ` Encode exactly ${atoms.length+1} LF-separated lines: the first ${atoms.length} lines correspond to source atoms a0 through a${atoms.length-1}, in SOURCE slot order. Each line is Japanese-occurrence-rank:preceding prose. The last line is the Japanese tail, without a rank. Keep an empty last line when tail is empty. Never insert LF inside prose.`:' Return the whole translated prose, without record prefixes.')};
  }
  const input={...base.input,output_format:'compact-ranked-original-nodes',pages:base.input.pages.map(p=>({...p,blocks:p.blocks.map(b=>{
    if(!b.translate_id)return b;
    let line=0;return {...b,source_parts:b.source_parts.map(part=>part.atom?{...part,line:++line}:part),...(line?{record_lines:line+1}:{})};
  })}))};
  const decode=(key,value)=>{
    const {atoms}=base.layouts.get(key);
    if(typeof value!=='string')return {issue:'node'};
    if(!atoms.length)return base.decode(key,value);
    const lines=value.split('\n');if(lines.length!==atoms.length+1)return {issue:'node'};
    const node={tail:lines.at(-1)};
    for(let i=0;i<atoms.length;i++){
      const packet=parseRankField(lines[i]);if(!packet)return {issue:'node'};node[atoms[i].key]=packet;
    }
    return base.decode(key,node);
  };
  const collector=(onEach=()=>{})=>{
    const seen=new Set();let unsafe=false;
    return jsonMembers(({id,value})=>{
      if(unsafe)return;
      if(!base.byKey.has(id)||seen.has(id)){unsafe=true;return;}
      seen.add(id);const result=decode(id,value);if(!result.issue)onEach(base.byKey.get(id).id,result.text);
    });
  };
  return {...base,input,schema:{type:'object',properties,required:[...base.byKey.keys()],additionalProperties:false},decode,collector,
    parse(body){
      if(body.status!=='completed')throw new Error('全文の翻訳が完了しませんでした');
      const text=(body.steps||[]).filter(s=>s.type==='model_output').flatMap(s=>s.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
      let entries;
      try{const c=jsonMembers();c.append(text);entries=c.finish();}catch{throw new Error('翻訳応答の形式が不正です。全文を再試行してください');}
      if(entries.some(e=>!base.byKey.has(e.id)))throw new Error('対象外の翻訳が含まれています');
      const values=new Map(entries.map(e=>[e.id,e.value])),out=new Map(),issues=[];
      for(const [key,source]of base.byKey){
        const result=values.has(key)?decode(key,values.get(key)):{issue:'missing'};
        if(result.issue)issues.push({id:source.id,reason:result.issue,source:source.text,translated:values.get(key)||''});else out.set(source.id,result.text);
      }
      if(issues.length)throw new MissingTranslationsError(`全文の翻訳を検証できませんでした（必要${ids.length}件／受信${entries.length}件、補完対象${issues.length}件）。有効な訳文を保持しています`,out,issues.map(i=>i.id),issues);
      return out;
    },
  };
}
export function compactNodePrompt(system,src,dst){
  return keyedPrompt(system,src,dst)
    .replace(/^- Return one JSON object.*$/m,'- Return the required JSON object with one STRING per block. Blocks without atoms use ordinary translated prose. For a block with k atoms, encode exactly k+1 LF-separated lines inside its string: line i (1-based) belongs to source atom ai-1, and contains ASCII Japanese-rank:preceding prose; the final line contains only the tail. Keep SOURCE SLOT order for the lines, even when their Japanese ranks reorder the atoms. Empty preceding prose is written as rank:; an empty tail requires a trailing LF. Do not trim it. Never insert LF within prose. Inside the encoded value, never emit nested JSON, source-slot labels, field names or extra headings. Required root keys and genuine source headings must still be returned or translated as specified.')
    .replace(/^- Write every mathematical expression.*$/m,'- Original math, references and alphanumeric identifiers are inserted locally, once each. Never write their source or tags in prose, and never reconstruct LaTeX or dollar-delimited math.')
    .replace(/^- The text was extracted.*$/m,'- Fix ordinary prose hyphenation only. Do not infer, complete or repair original atoms.')
    .replace(/^- Every translation value.*$/m,`- Write prose in ${dst}. Names and bibliography text can retain original spelling. Translate all ordinary prose.`)
    +'\n- First compose one natural translation of the WHOLE matching source block, using the full document for meaning. Then divide the prose before each original atom and after the last one. Assign a unique Japanese occurrence rank 0 through k-1 to each source slot. Reorder an atom only together with its own claim. source_parts are not separate translation tasks.\n- Preserve every condition, negation, comparative scope and claim strength. Less/fewer is not none. Never duplicate prose across records or complete a block with neighboring content.\n- Encoding example only: source slots a0=x and a1=sx may encode "1:から画像\\n0:ベクトル\\nを再構成する". The first line still belongs to x, but its Japanese rank is 1; local code renders sx before x. All LF separators must be valid JSON string escapes.';
}
export function createCompactNodeGeminiTranslator(options){
  return withOriginalFallback(createGeminiTranslator({...options,outputFormat:'keyed',taskBuilder:buildCompactNodeTask,promptBuilder:compactNodePrompt}));
}
