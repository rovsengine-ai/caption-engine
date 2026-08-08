import { shapeText, shapedToSvgPath, initShaper } from './dist/src/text/shaper.js';
await initShaper();
for (const size of [40,72,96,120]) {
  const d = shapedToSvgPath(await shapeText('का', size, {bold:true}));
  // find malformed numbers: two decimal points in one token
  const bad = d.match(/\d+\.\d+\.\d+/g);
  // find tokens
  const toks = d.match(/-?\d*\.?\d+/g) || [];
  const weird = toks.filter(t => (t.match(/\./g)||[]).length > 1);
  console.log('size', size, 'badPattern:', bad ? bad.slice(0,5) : 'none', 'weirdTokens:', weird.slice(0,5));
  if (size===72) {
    const i = d.search(/\d+\.\d+\.\d+/);
    if (i>=0) console.log('   context:', JSON.stringify(d.slice(Math.max(0,i-40), i+40)));
  }
}
