// Representation check only: replay already accepted historical strings through
// ranked nodes. Never rescue withheld results or call a model.
import { readFile,writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildNodeTask } from '../../node-translations.js';
export async function roundtripNodes(pages,translated){
  const ids=Object.entries(translated).filter(([,text])=>typeof text==='string').map(([id])=>id);
  const task=await buildNodeTask(pages,ids,'English','Japanese'),failures=[];
  let exact=0,inputChars=0,outputChars=0;
  for(const [key,source]of task.byKey){
    const text=translated[source.id],{atoms}=task.layouts.get(key),locations=[];
    let value=text;
    if(atoms.length){
      for(const atom of atoms){
        let start=0,at=-1;
        while((at=text.indexOf(atom.display,start))>=0){
          if(!locations.some(p=>p.at<at+atom.display.length&&p.end>at))break;
          start=at+atom.display.length;
        }
        if(at<0){failures.push({id:source.id,reason:'historical text does not preserve a newly required original atom'});break;}
        locations.push({atom,at,end:at+atom.display.length});
      }
      if(locations.length!==atoms.length)continue;
      value={};let previous=0;
      locations.sort((a,b)=>a.at-b.at).forEach((p,o)=>{value[p.atom.key]={o,t:text.slice(previous,p.at)};previous=p.end;});
      value.tail=text.slice(previous);
    }
    const decoded=task.decode(key,value);
    if(decoded.issue||decoded.text!==text){failures.push({id:source.id,reason:decoded.issue||'roundtrip text differs'});continue;}
    exact++;inputChars+=JSON.stringify(text).length;outputChars+=JSON.stringify(value).length;
  }
  return {historicalAcceptedStrings:ids.length,exact,failures,inputChars,outputChars,meaning:'Structural expressiveness only. Excluded/failed historical strings are not rescued, and this is not new translation quality evidence.'};
}
async function main(){
  const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
  for(const n of ['--input','--translations','--output'])if(!args.includes(n))throw new Error(n+' required');
  const result=await roundtripNodes(JSON.parse(await readFile(arg('--input'),'utf8')),JSON.parse(await readFile(arg('--translations'),'utf8')));
  await writeFile(arg('--output'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
