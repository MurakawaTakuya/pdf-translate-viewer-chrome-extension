import {buildKeyedTask} from './keyed-translations.js';

// Operational budgets, not published Gemini limits. A schema-specific 400 can
// still require a smaller batch. Keep ordinary papers in a single request.
export const DEFAULT_BATCH_LIMITS={maxTargets:128,maxSchemaBytes:80000,maxSchemaSplits:2};

export async function planTranslationBatches(pages,ids,src,dst,signal,options={}){
  const limits={...DEFAULT_BATCH_LIMITS,...options};
  for(const name of ['maxTargets','maxSchemaBytes'])if(!Number.isSafeInteger(limits[name])||limits[name]<1)throw new Error('Invalid translation batch budget');
  if(!Number.isSafeInteger(limits.maxSchemaSplits)||limits.maxSchemaSplits<0)throw new Error('Invalid schema split budget');
  const task=await buildKeyedTask(pages,ids,src,dst,signal),visited=new Set(),units=[];
  for(const [key]of task.byKey){
    if(visited.has(key))continue;
    const group=task.groups.get(key);for(const member of group)visited.add(member);
    units.push(group.map(member=>task.byKey.get(member).id));
  }
  const keyById=new Map([...task.byKey].map(([key,b])=>[b.id,key]));
  const make=groups=>{
    const ids=groups.flat(),keys=ids.map(id=>keyById.get(id));
    const schema={...task.schema,properties:Object.fromEntries(keys.map(key=>[key,task.schema.properties[key]])),required:keys};
    return {units:groups,ids,schemaBytes:new TextEncoder().encode(JSON.stringify(schema)).length};
  };
  const batches=[];let groups=[];
  for(const unit of units){
    const next=make([...groups,unit]);
    if(groups.length&&(next.ids.length>limits.maxTargets||next.schemaBytes>limits.maxSchemaBytes)){
      batches.push(make(groups));groups=[];
    }
    // An indivisible citation group or single huge paragraph can exceed a
    // budget. Do not split its source content or weaken its validation.
    groups.push(unit);
  }
  if(groups.length)batches.push(make(groups));
  return {batches,limits,split(batch){
    if(batch.units.length<2)return null;
    const half=Math.ceil(batch.units.length/2);
    return [make(batch.units.slice(0,half)),make(batch.units.slice(half))];
  }};
}
