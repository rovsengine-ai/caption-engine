const B='/sessions/dreamy-confident-dijkstra/mnt/outputs/caption-engine/dist/src';
const {transliterateToken} = await import(`${B}/transliterate/devanagari.js`);
const cases=['आवाज़','ज़','फ़','ख़','ग़','ड़','ढ़','क़','ज़रूर','बड़ा','बढ़िया','पड़ता','[घंटी की आवाज़]'];
for(const c of cases) console.log(JSON.stringify(c).padEnd(22), '->', JSON.stringify(transliterateToken(c)));
