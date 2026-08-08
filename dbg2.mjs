import { layoutCue } from './dist/src/captions/svg.js';
import { initShaper, shapeText } from './dist/src/text/shaper.js';
import { resolveStyle } from './dist/src/captions/style.js';
await initShaper();
const words=['आज','का','वीडियो','ख़ास'];
const cue={index:0,start:0,end:2,words:words.map((t,i)=>({text:t,start:i*0.4,end:i*0.4+0.35,confidence:1,type:'word',keep:true})),text:words.join(' ')};
const style={...resolveStyle('bold',1920),positionY:0.5,fontSizePx:72};
console.log('style.fontSizePx=',style.fontSizePx,'uppercase=',style.uppercase);
const lines=await layoutCue(cue,{width:1080,height:420,style});
for(const l of lines){
  console.log('line width',l.width.toFixed(2),'y',l.y.toFixed(2));
  for(const w of l.words) console.log('   ',w.word.text.padEnd(10),'x=',w.x.toFixed(2),'width=',w.width.toFixed(2),'shaped.width=',w.shaped.width.toFixed(2));
}
