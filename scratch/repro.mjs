// Reproduce the exact Sarvam 422 by standing in for the API with its documented
// validation rule: body.input must be <= 1000 characters.
import { readFileSync } from 'node:fs';
import { SarvamTransliterator } from '/sessions/dreamy-confident-dijkstra/mnt/outputs/caption-engine/dist/src/transliterate/providers.js';
import { romaniseTranscript } from '/sessions/dreamy-confident-dijkstra/mnt/outputs/caption-engine/dist/src/transliterate/index.js';

const t = JSON.parse(readFileSync('new-transcript.json', 'utf8'));

let seen = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const n = [...body.input].length;
  seen.push(n);
  if (n > 1000) {
    return new Response(JSON.stringify({
      error: { message: 'body.input: String should have at most 1000 characters' },
    }), { status: 422 });
  }
  return new Response(JSON.stringify({ transliterated_text: body.input }), { status: 200 });
};

try {
  await romaniseTranscript(t, new SarvamTransliterator('fake-key'), { language: 'hi' });
  console.log('NO ERROR — unexpected');
} catch (e) {
  console.log('ERROR:', e.message.slice(0, 200));
}
console.log('requests made:', seen.length, 'input char counts:', seen);
