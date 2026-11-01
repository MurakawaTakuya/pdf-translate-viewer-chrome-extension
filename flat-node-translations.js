// Same local original-node decoder, with a shallow all-string API schema.
// The schema requires each field; ranks are strict ASCII prefixes validated locally.
import { createGeminiTranslator,MissingTranslationsError } from './gemini.js';
import { buildNodeTask } from './node-translations.js';
import { withOriginalFallback } from './protected-translator.js';
import { keyedPrompt } from './keyed-translations.js';
import { jsonMembers } from './json-members.js';

export function parseRankField(field){
  if(typeof field!=='string')return null;
  const colon=field.indexOf(':'),rank=field.slice(0,colon);
  if(colon<0||!/^(?:0|[1-9]\d*)$/.test(rank)||!Number.isSafeInteger(Number(rank)))return null;
  return {o:Number(rank),t:field.slice(colon+1)};
}

export async function buildFlatNodeTask(pages,ids,src,dst,signal){
  const base=await buildNodeTask(pages,ids,src,dst,signal),properties={},fields=new Map(),byBlock=new Map(),used=new Set();
  const name=async(block,atom)=>{
    signal?.throwIfAborted();
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`flat:${block}:${atom}`));
    signal?.throwIfAborted();
    const hash=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
    let n=3,key;do{key='f'+hash.slice(0,n++);}while(used.has(key));used.add(key);return key;
  };
  for(const [block,source]of base.byKey){
    const layout=base.layouts.get(block),list=[];
    for(const atom of layout.atoms){
      const key=await name(source.id,atom.key);fields.set(key,{block,atom:atom.key});list.push(key);
      properties[key]={type:'string',description:`Block ${block}, original ${atom.kind} ${JSON.stringify(atom.source)}. Value is ASCII rank:prose immediately before this original atom in Japanese order. Do not emit the atom itself.`};
    }
    const key=await name(source.id,'tail');fields.set(key,{block,atom:null});list.push(key);byBlock.set(block,list);
    properties[key]={type:'string',description:base.schema.properties[block].description+(layout.atoms.length?' This field is only prose after the last original atom in Japanese order. No rank prefix.':' This field is the whole translation. No rank prefix.')};
  }
  const input={...base.input,output_format:'flat-ranked-original-nodes',pages:base.input.pages.map(page=>({...page,blocks:page.blocks.map(b=>{
    if(!b.translate_id)return b;
    const list=byBlock.get(b.translate_id),layout=base.layouts.get(b.translate_id);
    const names=new Map(layout.atoms.map((a,i)=>[a.key,list[i]]));
    return {...b,source_parts:b.source_parts.map(p=>p.atom?{...p,field:names.get(p.atom)}:p),
      ...(layout.atoms.length?{tail_field:list.at(-1)}:{whole_field:list[0]})};
  })}))};
  const assemble=(block,values)=>{
    const list=byBlock.get(block),layout=base.layouts.get(block);
    if(list.some(k=>!values.has(k)))return {issue:'missing'};
    const tail=values.get(list.at(-1));if(typeof tail!=='string')return {issue:'node'};
    if(!layout.atoms.length)return base.decode(block,tail);
    const value={tail};
    for(let i=0;i<layout.atoms.length;i++){
      const packet=parseRankField(values.get(list[i]));if(!packet)return {issue:'node'};
      value[layout.atoms[i].key]=packet;
    }
    return base.decode(block,value);
  };
  const collector=(onEach=()=>{})=>{
    const values=new Map();let unsafe=false;
    return jsonMembers(({id,value})=>{
      if(unsafe)return;
      if(!fields.has(id)||values.has(id)){unsafe=true;return;}
      values.set(id,value);const block=fields.get(id).block,result=assemble(block,values);
      if(!result.issue)onEach(base.byKey.get(block).id,result.text);
    });
  };
  return {...base,input,schema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false},fields,byBlock,assemble,collector,
    parse(body){
      if(body.status!=='completed')throw new Error('全文の翻訳が完了しませんでした');
      const text=(body.steps||[]).filter(s=>s.type==='model_output').flatMap(s=>s.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
      let entries;
      try{const c=jsonMembers();c.append(text);entries=c.finish();}catch{throw new Error('翻訳応答の形式が不正です。全文を再試行してください');}
      if(entries.some(e=>!fields.has(e.id)))throw new Error('対象外の翻訳フィールドが含まれています');
      const values=new Map(entries.map(e=>[e.id,e.value])),out=new Map(),issues=[];
      for(const [key,source]of base.byKey){
        const result=assemble(key,values);
        if(result.issue)issues.push({id:source.id,reason:result.issue,source:source.text,translated:JSON.stringify(Object.fromEntries(byBlock.get(key).filter(k=>values.has(k)).map(k=>[k,values.get(k)])))});
        else out.set(source.id,result.text);
      }
      if(issues.length)throw new MissingTranslationsError(`全文の翻訳を検証できませんでした（対象${ids.length}ブロック／受信${entries.length}フィールド、補完対象${issues.length}件）。有効な訳文を保持しています`,out,issues.map(i=>i.id),issues);
      return out;
    },
  };
}

export function flatNodePrompt(system,src,dst){
  return keyedPrompt(system,src,dst)
    .replace(/^- Return one JSON object.*$/m,'- Return one flat JSON object with ALL required property names and STRING values. For each atom field named by source_parts.field, write ASCII rank:prose, e.g. "0:ベクトル" or "1:". Split at the first colon only: everything after it is prose, including other colons or line breaks. A tail_field is prose after the last atom, without a rank. A whole_field is the entire translation, without a rank. Never return nested objects or arrays.')
    .replace(/^- Write every mathematical expression.*$/m,'- Original math, references and alphanumeric identifiers are inserted locally, once each. Never write their source or tags in prose, and never reconstruct LaTeX or dollar-delimited math.')
    .replace(/^- The text was extracted.*$/m,'- Fix ordinary prose hyphenation only. Do not infer, complete or repair original atoms.')
    .replace(/^- Every translation value.*$/m,`- Write prose in ${dst}. Keep source names/bibliographies when appropriate. Empty atom prose and empty tail are allowed, but ordinary source prose must not be omitted.`)
    +'\n- Compose one natural translation of the WHOLE matching block, using the full document for meaning. Then divide its prose immediately before each original atom and after the last atom. Assign a unique Japanese occurrence rank from 0 to k-1 to each atom field in that block. Reorder an atom only together with its own claim. source_parts are not independent translation tasks.\n- Preserve all conditions, negation, comparative scope and claim strength. Less/fewer means a smaller amount, not none. Never complete a block with neighboring source content, and never duplicate a phrase across fields.';
}

export function createFlatNodeGeminiTranslator(options){
  return withOriginalFallback(createGeminiTranslator({...options,outputFormat:'keyed',taskBuilder:buildFlatNodeTask,promptBuilder:flatNodePrompt}));
}
