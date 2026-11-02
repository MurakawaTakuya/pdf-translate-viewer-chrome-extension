// Use PDF drawing geometry plus nearby captions. No OCR or model calls.
import {OPS,Util} from './lib/pdf.min.mjs';

const overlap=(a,b)=>Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0));
const sharesColumn=(a,b)=>overlap(a,b)>=Math.min(a.x1-a.x0,b.x1-b.x0)*0.65;
const rect=(bounds,matrix)=>{
  const b=Util.getAxialAlignedBoundingBox(bounds,matrix);
  return {x0:b[0],top:b[1],x1:b[2],bottom:b[3]};
};

export function drawingGeometry(operators,viewport){
  const graphics=[],rules=[],stack=[];let matrix=[1,0,0,1,0,0],paths=[];
  const box=b=>rect(b,Util.transform(viewport.transform,matrix));
  const addGraphic=b=>{if(b.x1-b.x0>=35*viewport.scale&&b.bottom-b.top>=20*viewport.scale)graphics.push(b);};
  const paint=new Set([OPS.stroke,OPS.closeStroke,OPS.fill,OPS.eoFill,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke]);
  for(let i=0;i<(operators?.fnArray.length||0);i++){
    const op=operators.fnArray[i],args=operators.argsArray[i];
    if(op===OPS.save)stack.push([...matrix]);
    else if(op===OPS.restore)matrix=stack.pop()||[1,0,0,1,0,0];
    else if(op===OPS.transform)matrix=Util.transform(matrix,args);
    else if(op===OPS.paintFormXObjectBegin){stack.push([...matrix]);if(args[0])matrix=Util.transform(matrix,args[0]);if(args[1])addGraphic(box(args[1]));}
    else if(op===OPS.paintFormXObjectEnd)matrix=stack.pop()||[1,0,0,1,0,0];
    else if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintSolidColorImageMask].includes(op))addGraphic(box([0,0,1,1]));
    else if(op===OPS.constructPath&&args[2])paths.push(box(args[2]));
    else if(paint.has(op)){
      for(const b of paths)if(b.x1-b.x0>=40*viewport.scale&&b.bottom-b.top<=2*viewport.scale)rules.push(b);
      paths=[];
    }else if(op===OPS.endPath)paths=[];
  }
  return {graphics,rules};
}

export function excludeFigureText(blocks,geometry,body,pageHeight){
  const regions=[],captions=blocks.filter(b=>b.kind==='caption');
  for(const graphic of geometry.graphics){
    const candidates=captions.filter(c=>/^Fig/i.test(c.text)&&sharesColumn(c,graphic)).map(c=>{
      const below=graphic.bottom<=c.top+body*0.2,above=graphic.top>=c.bottom-body*0.2;
      return {c,below,gap:below?c.top-graphic.bottom:above?graphic.top-c.bottom:Infinity};
    }).filter(c=>c.gap<=body*8).sort((a,b)=>a.gap-b.gap);
    if(!candidates.length)continue;
    const {c,below}=candidates[0];
    regions.push({...graphic,x0:graphic.x0-body,x1:graphic.x1+body,top:below?graphic.top-body*1.5:c.bottom,bottom:below?c.top:graphic.bottom+body*1.5,kind:'figure'});
  }
  const usedRules=new Set();
  for(const caption of captions.filter(c=>/^Table/i.test(c.text))){
    const nearby=geometry.rules.filter(r=>!usedRules.has(r)&&(sharesColumn(r,caption)||(caption.x1-caption.x0<body*5&&caption.x0>=r.x0-body*2&&caption.x0<r.x1))).map(r=>({r,below:r.bottom<=caption.top,gap:r.bottom<=caption.top?caption.top-r.bottom:r.top>=caption.bottom?r.top-caption.bottom:Infinity}))
      .filter(x=>x.gap<=body*12).sort((a,b)=>a.gap-b.gap);
    if(!nearby.length)continue;
    const before=nearby.find(x=>x.below),after=nearby.find(x=>!x.below);
    // A following table may be closer than the current table's internal rule.
    // Prefer the preceding table unless a rule immediately follows an above-table caption.
    const {r:anchor,below}=before&&!(after&&after.gap<body*1.5&&before.gap>body*5)?before:nearby[0];
    const barriers=blocks.filter(b=>b!==caption&&sharesColumn(b,anchor)&&(b.kind==='caption'||b.lines.length>=3&&b.text.length>180
      ||b.kind==='heading'&&/^(?:\d+(?:\.\d+)*[.)]?|[A-Z]\.)\s+\p{L}/u.test(b.text)));
    const limit=below?Math.max(caption.top-pageHeight*0.55,...barriers.filter(b=>b.bottom<anchor.top).map(b=>b.bottom)):
      Math.min(caption.bottom+pageHeight*0.55,...barriers.filter(b=>b.top>anchor.bottom).map(b=>b.top));
    const rules=geometry.rules.filter(r=>!usedRules.has(r)&&r.x0>=anchor.x0-body*2&&r.x1<=anchor.x1+body*2&&sharesColumn(r,anchor)
      &&(below?r.top>=limit&&r.bottom<=anchor.bottom+1:r.top>=anchor.top-1&&r.bottom<=limit));
    if(!rules.length)continue;
    for(const rule of rules)usedRules.add(rule);
    const top=Math.min(...rules.map(r=>r.top)),bottom=Math.max(...rules.map(r=>r.bottom));
    regions.push({x0:anchor.x0-body*0.3,x1:anchor.x1+body*0.3,top:below?Math.max(limit,top-body*2.5):caption.bottom+body*0.2,
      bottom:below?caption.top-body*0.2:Math.min(limit,bottom+body*0.2),kind:'table'});
  }
  for(const block of blocks){
    if(block.kind==='caption')continue;
    const area=(block.x1-block.x0)*(block.bottom-block.top);
    if(area<=0)continue;
    const region=regions.find(r=>overlap(block,r)*Math.max(0,Math.min(block.bottom,r.bottom)-Math.max(block.top,r.top))>=area*0.65);
    if(region){block.translate=false;block.translationSkip=region.kind;}
  }
  return regions;
}
