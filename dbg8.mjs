import { renderCueSvg } from './dist/src/captions/svg.js';
import { resolveStyle } from './dist/src/captions/style.js';
import { initShaper } from './dist/src/text/shaper.js';
import { writeFileSync } from 'node:fs';
await initShaper();
const words=['आज','का','वीडियो','ख़ास'];
const cue={index:0,start:0,end:2,words:words.map((t,i)=>({text:t,start:i*0.4,end:i*0.4+0.35,confidence:1,type:'word',keep:true})),text:words.join(' ')};
const style={...resolveStyle('bold',1920),positionY:0.5,fontSizePx:72,outlineWidthPx:0};
const svg=await renderCueSvg(cue,{width:1080,height:300,style,activeWordIndex:-1});
writeFileSync('/tmp/cue_full.svg', svg);
const paths=[...svg.matchAll(/<path[^>]*\/>/g)].map(m=>m[0]);
console.log('path elements:', paths.length);
paths.forEach((p,i)=>{
  const t=p.match(/transform="([^"]*)"/)?.[1];
  const dlen=p.match(/d="([^"]*)"/)?.[1].length;
  console.log(` [${i}] transform=${t} dLen=${dlen}`);
});
// render ONLY the 'का' path (index 1) standalone at same canvas
const ka = paths[1];
writeFileSync('/tmp/ka_only.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="300" viewBox="0 0 1080 300"><rect width="100%" height="100%" fill="#111"/>${ka}</svg>`);
