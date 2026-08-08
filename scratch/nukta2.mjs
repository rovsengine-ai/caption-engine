import { readFileSync } from 'node:fs';
const B='/sessions/dreamy-confident-dijkstra/mnt/outputs/caption-engine/dist/src';
const {transliterateToken} = await import(`${B}/transliterate/devanagari.js`);
const d = JSON.parse(readFileSync('new-transcript.json','utf8'));
for (const i of [1648,1724]) {
  const t = d.words[i].text;
  console.log('token', i, JSON.stringify(t));
  console.log('  codepoints:', [...t].map(c=>'U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')).join(' '));
  console.log('  whole      ->', JSON.stringify(transliterateToken(t)));
  console.log('  per-word   ->', JSON.stringify(t.split(/\s+/).map(transliterateToken).join(' ')));
}
// isolate: does a trailing ] break nukta?
for (const s of ['आवाज़','आवाज़]','[आवाज़','आवाज़।','की','[घंटी']) {
  console.log(JSON.stringify(s).padEnd(18),'->',JSON.stringify(transliterateToken(s)));
}
