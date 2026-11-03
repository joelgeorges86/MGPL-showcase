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

    console.log('Fetching scripts...');
    for (const url of urls) {
      const scriptRes = await globalThis.fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const text = await scriptRes.text();
      // Look for "/api/search" or "search" or anything in the text
      // Let's do a case-insensitive search for "/api/" or "concat"
      const match = text.match(/\/api\/[a-zA-Z0-9_/.-]+/g);
      if (match) {
        console.log('Found API links in:', url);
        console.log(match);
      }
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

run();
