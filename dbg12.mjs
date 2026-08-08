import { shapeText, shapedToSvgPath, initShaper } from './dist/src/text/shaper.js';
await initShaper();
const only = Number(process.argv[2]);
const sizes = process.argv[3] ? process.argv[3].split(',').map(Number) : [only];
let last;
for (const s of sizes) {
  last = shapedToSvgPath(await shapeText('का', s, {bold:true}));
  console.log('  shaped at', s, 'len', last.length);
}
// print bbox of final
const n=(last.match(/-?\d+(\.\d+)?/g)||[]).map(Number);
let xs=[],ys=[]; for(let i=0;i+1<n.length;i+=2){xs.push(n[i]);ys.push(n[i+1]);}
console.log('  final bbox x[',Math.min(...xs).toFixed(1),',',Math.max(...xs).toFixed(1),'] y[',Math.min(...ys).toFixed(1),',',Math.max(...ys).toFixed(1),']');
