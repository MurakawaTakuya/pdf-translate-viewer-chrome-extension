import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCurrent, citationDiagnostics } from '../scripts/evaluation/reproduce-current.mjs';
import { legacyRequest } from '../scripts/evaluation/legacy-format.mjs';

test('current reproduction captures the unmodified viewer default without making a live request',async()=>{
  const pages=[{page:1,blocks:[{id:'p1-b0',text:'Figure reference',translate:false,kind:'other'},
    {id:'p1-b1',text:'Paragraph with a reference [11].',translate:true,kind:'paragraph'}]}];
  const variant=await captureCurrent(pages);
  assert.deepEqual(variant.request,legacyRequest(pages,['p1-b1']));
  assert.equal(variant.targets[0].wire,1);
  assert.equal(variant.protocol,'sequential-flat');
  assert.equal(JSON.parse(variant.request.input).targets,undefined);
  assert.doesNotMatch(JSON.stringify(variant.request),/offline-placeholder|apiKey/);
});

test('citation diagnostics expose missing and neighboring references but do not claim semantic correctness',()=>{
  const variant={targets:[
    {id:'a',page:1,text:'First paragraph [15, 20].'},
    {id:'b',page:1,text:'Next paragraph [11].'},
    {id:'appendix',page:12,text:'Appendix [8].'},
  ]};
  const result={analysis:{translated:{a:'訳文 [15,20,11]',b:'別の訳文',appendix:'付録'}}};
  assert.deepEqual(citationDiagnostics(variant,result),[
    {id:'a',page:1,missing:[],extra:[11]},
    {id:'b',page:1,missing:[11],extra:[]},
  ]);
});
