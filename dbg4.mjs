import { shapeText, shapedToSvgPath, runToSvgPath, initShaper } from './dist/src/text/shaper.js';
await initShaper();
const s = await shapeText('का', 72, {bold:true});
const full = shapedToSvgPath(s);
console.log('full path len:', full.length);
// bbox of the path numbers
function bbox(d){
  const cmds=[...d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)];
  let xs=[],ys=[];
  for(const [,c,args] of cmds){
    const n=(args.match(/-?\d+(\.\d+)?/g)||[]).map(Number);
    for(let i=0;i+1<n.length;i+=2){xs.push(n[i]);ys.push(n[i+1]);}
  }
  return {minx:Math.min(...xs),maxx:Math.max(...xs),miny:Math.min(...ys),maxy:Math.max(...ys),n:xs.length};
}
console.log('bbox full:', JSON.stringify(bbox(full)));
// per glyph
const run=s.runs[0];
for(const g of run.glyphs){
  const gl=run.handles.ot.glyphs.get(g.glyphId);
  const d=gl.getPath(g.x*(72/run.handles.unitsPerEm), 0, 72).toPathData(2);
  console.log(` gid=${g.glyphId} x=${g.x} -> bbox`, JSON.stringify(bbox(d)));
}
