import { shapeText, initShaper } from './dist/src/text/shaper.js';
await initShaper();
for (const size of [72,120]) {
  const s = await shapeText('का', size, {bold:true});
  const run = s.runs[0];
  const scale = size / run.handles.unitsPerEm;
  console.log(`\n=== size ${size} scale ${scale} ===`);
  for (const g of run.glyphs) {
    const gl = run.handles.ot.glyphs.get(g.glyphId);
    const px = g.x * scale, py = -g.y * scale;
    const d = gl.getPath(px, py, size).toPathData(2);
    const cmds = (d.match(/[MLQCZ]/g)||[]).join('');
    console.log(` gid=${g.glyphId} g.x=${g.x} g.y=${g.y} -> px=${px.toFixed(2)} py=${py.toFixed(2)} cmds(${cmds.length})=${cmds.slice(0,30)}`);
    const n=(d.match(/-?\d+(\.\d+)?/g)||[]).map(Number);
    console.log(`    first coords: ${n.slice(0,6).map(v=>v.toFixed(2)).join(', ')}`);
  }
}
