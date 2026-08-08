import { readFileSync } from 'node:fs';
const B='/sessions/dreamy-confident-dijkstra/mnt/outputs/caption-engine/dist/src';
const { SarvamTransliterator } = await import(`${B}/transliterate/providers.js`);
const { romaniseTranscript } = await import(`${B}/transliterate/index.js`);

const t = JSON.parse(readFileSync('new-transcript.json','utf8'));

let sizes=[], reqs=0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const n = [...body.input].length;
  sizes.push(n); reqs++;
  if (n > 1000) return new Response(JSON.stringify({error:{message:'body.input: String should have at most 1000 characters'}}),{status:422});
  // Stand-in model: uppercase-mark each piece so we can see it round-tripped.
  const out = body.input.split('|').map(s=>'X'+s.trim()).join(' | ');
  return new Response(JSON.stringify({transliterated_text: out}),{status:200});
};

const p = new SarvamTransliterator('fake-key');
const r = await romaniseTranscript(t, p, { language: 'hi' });
console.log('input words :', t.words.length);
console.log('output words:', r.transcript.words.length);
console.log('requests    :', reqs, 'max input chars:', Math.max(...sizes), 'sizes:', sizes.join(','));
console.log('stats       :', JSON.stringify(p.stats));
const same = t.words.every((w,i)=> r.transcript.words[i].start===w.start && r.transcript.words[i].end===w.end && r.transcript.words[i].confidence===w.confidence);
console.log('timings identical:', same);
const converted = r.transcript.words.filter(w=>w.roman?.startsWith('X')).length;
console.log('tokens that went through the API:', converted);
