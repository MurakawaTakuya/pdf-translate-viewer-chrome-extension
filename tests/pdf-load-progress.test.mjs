import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPdfLoadProgress } from '../pdf-load-progress.js';
const source = await readFile(new URL('../viewer.js',import.meta.url),'utf8');
const loadSource = source.slice(source.indexOf('async function load()'),source.indexOf('async function buildRows()'));
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const tick = () => new Promise(setImmediate);
function fixture() {
  const attrs=new Map(),classes=new Set(),timers=new Map();let id=0;
  const bar={hidden:true,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),classList:{toggle:(k,on)=>on?classes.add(k):classes.delete(k)}};
  const fill={style:{}};
  const progress=createPdfLoadProgress(bar,fill,{schedule:fn=>{timers.set(++id,fn);return id;},cancel:id=>timers.delete(id)});
  return {bar,fill,attrs,classes,progress,timers,flush(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(fn=>fn());}};
}

test('unknown size is indeterminate; actual byte progress is clamped, monotonic and ignores invalid events',()=>{
  const f=fixture();f.progress.start();
  assert.equal(f.bar.hidden,false);assert.ok(f.classes.has('indeterminate'));assert.equal(f.attrs.get('aria-valuenow'),undefined);
  f.progress.update({loaded:50,total:0});assert.ok(f.classes.has('indeterminate'));
  f.progress.update({loaded:30,total:100});assert.equal(f.fill.style.transform,'scaleX(0.3)');assert.equal(f.attrs.get('aria-valuenow'),'30');
  f.progress.update({loaded:20,total:100});assert.equal(f.attrs.get('aria-valuenow'),'30');
  for(const event of [{loaded:NaN,total:100},{loaded:-1,total:100},{loaded:99,total:Infinity}])f.progress.update(event);
  assert.equal(f.attrs.get('aria-valuenow'),'30');
  f.progress.update({loaded:150,total:100});assert.equal(f.attrs.get('aria-valuenow'),'100');
  f.progress.prepare();assert.ok(f.classes.has('preparing'));assert.equal(f.attrs.get('aria-valuenow'),undefined);
  f.progress.update({loaded:5,total:100});assert.ok(f.classes.has('preparing'));
});

test('completion briefly reaches the right edge; restart cancels hiding and failure clears progress',()=>{
  const f=fixture();f.progress.start();f.progress.complete();
  assert.equal(f.bar.hidden,false);assert.equal(f.fill.style.transform,'scaleX(1)');assert.equal(f.timers.size,1);
  f.progress.start();f.flush();assert.equal(f.bar.hidden,false);assert.ok(f.classes.has('indeterminate'));
  f.progress.complete();f.flush();assert.equal(f.bar.hidden,true);
  f.progress.start();f.progress.fail();f.progress.update({loaded:90,total:100});f.progress.complete();
  assert.equal(f.bar.hidden,true);assert.equal(f.timers.size,0);assert.equal(f.attrs.get('aria-valuenow'),undefined);
});

function loader({failureStage,autoTranslate=false}={}) {
  const f=fixture(),network=deferred(),rows=deferred(),paint=deferred(),state={rows:[],settings:{autoTranslate}};
  const task={promise:network.promise},translations=[],dstSel={value:'ko'};let status='',built=false,painted=false;
  const load=vm.runInNewContext(`(function(){${loadSource};return load;})()`,{
    fileUrl:'https://example.test/paper.pdf',state,autoTranslatePending:true,document:{},console:{error(){}},
    $:()=>({}),setStatus:text=>{status=text;},pdfLoadProgress:f.progress,
    pdfjsLib:{getDocument:()=>task},srcSel:{value:'en'},dstSel,start:async(engine)=>{translations.push([engine,dstSel.value]);},
    buildRows:async()=>{built=true;if(failureStage==='rows')throw new Error('rows');await rows.promise;state.rows=[{}];},
    renderPage:async()=>{painted=true;if(failureStage==='paint')throw new Error('paint');await paint.promise;},
  });
  return {...f,load,network,rows,paint,task,state,translations,status:()=>status,built:()=>built,painted:()=>painted};
}

test('actual load wires PDF.js byte events and stays visible through row preparation and first paint',async()=>{
  const f=loader(),pending=f.load();
  f.task.onProgress({loaded:40,total:100});assert.equal(f.attrs.get('aria-valuenow'),'40');
  f.network.resolve({numPages:1});await tick();
  assert.ok(f.built());assert.ok(f.classes.has('preparing'));assert.equal(f.bar.hidden,false);
  f.rows.resolve();await tick();assert.ok(f.painted());assert.equal(f.timers.size,0);
  f.paint.resolve();await pending;
  assert.equal(f.attrs.get('aria-valuenow'),'100');assert.equal(f.status(),'');
  f.flush();assert.equal(f.bar.hidden,true);
});

test('network, row and first-paint failures hide the bar and show the existing load error',async(t)=>{
  for(const stage of ['network','rows','paint'])await t.test(stage,async()=>{
    const f=loader({failureStage:stage}),pending=f.load();
    if(stage==='network')f.network.reject(new Error('network'));else f.network.resolve({});
    f.rows.resolve();f.paint.resolve();await pending;
    assert.equal(f.bar.hidden,true);assert.equal(f.timers.size,0);assert.match(f.status(),/PDFを開けませんでした/);
  });
});

test('cached loads with no progress notifications still finish and hide the bar',async()=>{
  const f=loader();f.network.resolve({});f.rows.resolve();f.paint.resolve();
  await f.load();f.flush();assert.equal(f.bar.hidden,true);assert.equal(f.status(),'');
});


test('automatic local translation starts only after PDF preparation and the first paint finish',async()=>{
  const f=loader({autoTranslate:true}),pending=f.load();
  f.network.resolve({});f.rows.resolve();await tick();
  assert.equal(f.translations.length,0);
  f.paint.resolve();await pending;
  assert.deepEqual(f.translations,[['chrome','ja']]);
  assert.equal(f.attrs.get('aria-valuenow'),'100');
});
