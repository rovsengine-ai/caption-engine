import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { renderCueSvg } from './dist/src/captions/svg.js';
import { resolveStyle } from './dist/src/captions/style.js';
import { initShaper } from './dist/src/text/shaper.js';

await initShaper();
const mk = (words) => ({index:0,start:0,end:2,words:words.map((t,i)=>({text:t,start:i*0.4,end:i*0.4+0.35,confidence:1,type:'word',keep:true})),text:words.join(' ')});
const style = {...resolveStyle('bold',1920), positionY:0.5, fontSizePx:72};

const cases = [
  ['hindi', ['आज','का','वीडियो','ख़ास']],
  ['conjunct', ['विद्या','क्षेत्र','त्रिशूल']],
  ['telugu', ['నేను','ఈరోజు','చెప్తాను']],
  ['kannada', ['ನಾನು','ಇವತ್ತು','ಹೇಳ್ತೀನಿ']],
  ['tamil', ['நான்','இன்று','சொல்கிறேன்']],
  ['hinglish', ['ye','बहुत','important','है']],
];

for (const [name, words] of cases) {
  const svg = await renderCueSvg(mk(words), {width:1080,height:400,style,activeWordIndex:1,activeScale:1.08});
  const r = new Resvg(svg, { background: 'rgba(0,0,0,0)' });  // transparent
  const png = r.render();
  const buf = png.asPng();
  writeFileSync(`/tmp/resvg_${name}.png`, buf);
  console.log(`${name.padEnd(10)} ${png.width}x${png.height}  ${buf.length} bytes`);
}
// verify transparency: check the PNG has an alpha channel
console.log('\n--- transparency check ---');
const svg = await renderCueSvg(mk(['आज','test']), {width:400,height:200,style,activeWordIndex:0});
const r = new Resvg(svg, { background: 'rgba(0,0,0,0)' });
const img = r.render();
const px = img.pixels; // RGBA
let transparent=0, opaque=0;
for (let i=3;i<px.length;i+=4){ if(px[i]===0) transparent++; else opaque++; }
console.log(`transparent px: ${transparent}  opaque px: ${opaque}  (both >0 = real alpha)`);
