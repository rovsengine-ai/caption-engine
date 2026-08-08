import { transliterateText, transliterateToken } from './dist/src/transliterate/devanagari.js';
const cases = [
  ['आज meeting बहुत important है', 'Aaj meeting bahut important hai'],
  ['आज का वीडियो बहुत ख़ास है', ''],
  ['मैं आज आपको एक important बात बताता हूँ', ''],
  ['ये बहुत अच्छा project है', ''],
  ['नमस्ते दुनिया', ''],
  ['समझना', ''], ['करना',''], ['बहुत',''], ['आज',''],
  ['क्षेत्र',''], ['विद्या',''], ['त्रिशूल',''],
  ['कंपनी',''], ['हिन्दी',''], ['सम्बन्ध',''],
  ['5 मिनट में', ''], ['१२३ रुपये', ''],
];
for (const [inp, want] of cases) {
  const got = transliterateText(inp);
  const mark = want ? (got.toLowerCase()===want.toLowerCase() ? 'OK ' : 'DIFF') : '   ';
  console.log(`${mark} ${inp.padEnd(42)} -> ${got}${want && got.toLowerCase()!==want.toLowerCase() ? `   (want: ${want})` : ''}`);
}
