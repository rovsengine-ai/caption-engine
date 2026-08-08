import { shapeText, shapedToSvgPath, initShaper } from './dist/src/text/shaper.js';
await initShaper();
for (const w of ['आज','का','वीडियो','ख़ास','నేను','ఈరోజు','చెప్తాను','ಹೇಳ್ತೀನಿ','important']) {
  const s = await shapeText(w, 72, { bold: true });
  const d = shapedToSvgPath(s);
  const runs = s.runs.map(r => ({script:r.script, glyphs:r.glyphs.length, wUnits:r.width, upem:r.handles.unitsPerEm, font:r.font.path.split('/').pop()}));
  console.log(w.padEnd(12), 'widthPx=', s.width.toFixed(1).padStart(7), 'pathLen=', String(d.length).padStart(6), JSON.stringify(runs));
}
