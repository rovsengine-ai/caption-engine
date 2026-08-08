import { shapeText, shapedToSvgPath, initShaper } from './dist/src/text/shaper.js';
import { layoutCue } from './dist/src/captions/svg.js';
import { resolveStyle } from './dist/src/captions/style.js';
await initShaper();

// A: isolated (what worked)
const iso = await shapeText('का', 72, {bold:true});
const dIso = shapedToSvgPath(iso);

// B: via layoutCue (what breaks)
const words=['आज','का','वीडियो','ख़ास'];
const cue={index:0,start:0,end:2,words:words.map((t,i)=>({text:t,start:i*0.4,end:i*0.4+0.35,confidence:1,type:'word',keep:true})),text:words.join(' ')};
const style={...resolveStyle('bold',1920),positionY:0.5,fontSizePx:72};
const lines=await layoutCue(cue,{width:1080,height:300,style});
const kaLw = lines[0].words.find(w=>w.word.text==='का');
const dCue = shapedToSvgPath(kaLw.shaped);

console.log('isolated pathLen:', dIso.length);
console.log('cue      pathLen:', dCue.length);
console.log('identical:', dIso===dCue);
console.log('iso glyphs:', iso.runs[0].glyphs.map(g=>g.glyphId).join(','));
console.log('cue glyphs:', kaLw.shaped.runs[0].glyphs.map(g=>g.glyphId).join(','));
console.log('iso font:', iso.runs[0].font.path.split('/').pop());
console.log('cue font:', kaLw.shaped.runs[0].font.path.split('/').pop());
console.log('iso first 100:', dIso.slice(0,100));
console.log('cue first 100:', dCue.slice(0,100));
