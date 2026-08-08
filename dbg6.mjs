import { renderCueSvg } from './dist/src/captions/svg.js';
import { renderPreviewFrame } from './dist/src/render/pipeline.js';
import { resolveStyle } from './dist/src/captions/style.js';
import { initShaper } from './dist/src/text/shaper.js';
await initShaper();
const words=['आज','का','वीडियो','ख़ास'];
const cue={index:0,start:0,end:2,words:words.map((t,i)=>({text:t,start:i*0.4,end:i*0.4+0.35,confidence:1,type:'word',keep:true})),text:words.join(' ')};
for (const [name, ow] of [['out0',0],['out3',3],['out8',8],['out16',16]]) {
  const style={...resolveStyle('bold',1920),positionY:0.5,fontSizePx:72,outlineWidthPx:ow};
  const svg=await renderCueSvg(cue,{width:1080,height:300,style,activeWordIndex:-1});
  await renderPreviewFrame(svg, `/tmp/cue_${name}.png`, '#12161c', {width:1080,height:300});
  console.log(name,'outlineWidthPx=',ow,'-> stroke-width=',ow*2);
}
