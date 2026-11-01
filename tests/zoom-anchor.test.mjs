import test from 'node:test';
import assert from 'node:assert/strict';
import { horizontalZoomShift } from '../zoom-anchor.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const base={left:200,width:600,pointer:750,start:0,end:1000};
const position=(g,s)=>g.pointer+(g.left-g.pointer)*s+horizontalZoomShift(g,s);

test('off-center pointer cannot pull a page away from the center while margins remain',()=>{
  for(const scale of [0.5,0.9,1,1.2,1.6])near(position(base,scale)+base.width*scale/2,500);
});
test('crossing the width boundary is continuous and only the extra scale uses the pointer',()=>{
  const fit=1000/600;
  near(position(base,fit),0);
  near(position(base,fit-1e-8),3e-6);
  near(position(base,fit+1e-8),-4.5e-6);
  near(position(base,2),-150);
});
test('already overflowing pages stay anchored under the pointer, within scrollable edges',()=>{
  const wide={...base,left:-150,width:1200};
  near(horizontalZoomShift(wide,1.2),0);
  near(position({...wide,left:0},0.9),0);
  near(position({...wide,left:-200},0.9),-80);
});
test('shrinking into margins restores the center during the gesture rather than at its end',()=>{
  const wide={...base,left:-150,width:1200};
  near(position(wide,0.7),80);
  near(position(wide,0.5),200);
});
test('viewport padding participates in centering and invalid geometry cannot cause a jump',()=>{
  const padded={...base,left:214,start:14,end:1014};
  near(position(padded,1.2)+padded.width*1.2/2,514);
  near(horizontalZoomShift({...base,width:NaN},1.2),0);
  near(horizontalZoomShift({...base,end:0},1.2),0);
});
