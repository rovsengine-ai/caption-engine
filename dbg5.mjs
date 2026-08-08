import { shapeText, shapedToSvgPath, initShaper } from './dist/src/text/shaper.js';
import { writeFileSync } from 'node:fs';
await initShaper();
for (const [name,txt] of [['ka','का'],['aaj','आज'],['nenu','నేను']]) {
  const s = await shapeText(txt, 120, {bold:true});
  const d = shapedToSvgPath(s);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300"><rect width="100%" height="100%" fill="#111"/><g transform="translate(40,200)"><path d="${d}" fill="white"/></g></svg>`;
  writeFileSync(`/tmp/iso_${name}.svg`, svg);
  console.log(name, 'pathLen', d.length);
}
