import opentype from 'opentype.js';
import { readFileSync } from 'node:fs';
import { shapeText, initShaper } from './dist/src/text/shaper.js';
await initShaper();
const s = await shapeText('का', 72, {bold:true});
const run = s.runs[0];
console.log('font:', run.font.path.split('/').pop());
const raw = readFileSync(run.font.path);
const ot = opentype.parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength));
for (const g of run.glyphs) {
  const glyph = ot.glyphs.get(g.glyphId);
  const p = glyph ? glyph.getPath(0,0,72) : null;
  const d = p ? p.toPathData(2) : '';
  console.log(`  gid=${g.glyphId} name=${glyph?.name} unicode=${glyph?.unicode} adv=${g.xAdvance} pathLen=${d.length} numPoints=${glyph?.path?.commands?.length ?? 'n/a'}`);
}
console.log('--- Telugu నేను ---');
const t = await shapeText('నేను', 72, {bold:true});
const r2 = t.runs[0];
const raw2 = readFileSync(r2.font.path);
const ot2 = opentype.parse(raw2.buffer.slice(raw2.byteOffset, raw2.byteOffset+raw2.byteLength));
for (const g of r2.glyphs) {
  const gl = ot2.glyphs.get(g.glyphId);
  const d = gl ? gl.getPath(0,0,72).toPathData(2) : '';
  console.log(`  gid=${g.glyphId} name=${gl?.name} adv=${g.xAdvance} pathLen=${d.length}`);
}
