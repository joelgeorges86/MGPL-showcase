const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function run() {
  try {
    const res = await globalThis.fetch('https://howlongtobeat.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await res.text();
    const scriptRegex = /src="([^"]+)"/g;
    let m;
    const urls = [];
    while ((m = scriptRegex.exec(html)) !== null) {
      let src = m[1];
      if (src.startsWith('/')) {
        src = `https://howlongtobeat.com${src}`;
      }
      urls.push(src);
    }

    for (const url of urls) {
      const scriptRes = await globalThis.fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const text = await scriptRes.text();
      // Look for "/api/" (case-insensitive)
      const idx = text.toLowerCase().indexOf('/api/');
      if (idx !== -1) {
        console.log('--- Found /api/ in', url);
        // let's print all matches with context of 50 chars before and after
        const matches = [...text.matchAll(/\/api\/[a-zA-Z0-9_/.-]+/gi)];
        for (const match of matches) {
          const matchIdx = match.index;
          console.log(`Match: ${match[0]} at ${matchIdx}`);
          console.log(text.slice(Math.max(0, matchIdx - 100), Math.min(text.length, matchIdx + 200)));
        }
      }
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

run();
