import { shapeText, shapedToSvgPath, initShaper } from './dist/src/text/shaper.js';
import { writeFileSync } from 'node:fs';
await initShaper();
for (const size of [40, 72, 96, 120]) {
  const s = await shapeText('का', size, {bold:true});
  const d = shapedToSvgPath(s);
  writeFileSync(`/tmp/sz_${size}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220"><rect width="100%" height="100%" fill="#111"/><path d="${d}" transform="translate(60,150)" fill="white"/></svg>`);
  console.log('size', size, 'dLen', d.length, 'first60:', d.slice(0,60));
}
