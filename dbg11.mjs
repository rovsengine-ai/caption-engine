import { shapeText, shapedToSvgPath, initShaper } from './dist/src/text/shaper.js';
import { writeFileSync } from 'node:fs';
await initShaper();
const d = shapedToSvgPath(await shapeText('का', 72, {bold:true}));
const variants = {
  plain:      `<path d="${d}" transform="translate(60,150)" fill="white"/>`,
  nonzero:    `<path d="${d}" transform="translate(60,150)" fill="white" fill-rule="nonzero"/>`,
  evenodd:    `<path d="${d}" transform="translate(60,150)" fill="white" fill-rule="evenodd"/>`,
  scaled2x:   `<g transform="translate(60,150) scale(2)"><path d="${d}" fill="white"/></g>`,
};
for (const [k,v] of Object.entries(variants)) {
  writeFileSync(`/tmp/fr_${k}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220"><rect width="100%" height="100%" fill="#111"/>${v}</svg>`);
}
console.log(Object.keys(variants).join(' '));
