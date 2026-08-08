import { readFileSync, writeFileSync } from 'node:fs';
const B='/sessions/dreamy-confident-dijkstra/mnt/outputs/caption-engine/dist/src';
const { toRomanScript } = await import(`${B}/transliterate/index.js`);

const src = JSON.parse(readFileSync('new-transcript.json','utf8'));
// Exactly the call the CLI makes (src/cli/run.ts), against the live HTTP server.
const r = await toRomanScript(src, {
  provider: 'sarvam',
  language: src.language,
  protectEnglish: true,
});
writeFileSync('verify-sarvam-transcript.json', JSON.stringify(r.transcript, null, 1));
console.log(JSON.stringify({
  provider: r.provider, converted: r.converted, preserved: r.preserved,
  batching: r.batching,
}, null, 1));
