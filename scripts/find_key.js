const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function run() {
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
    try {
      const scriptRes = await globalThis.fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const text = await scriptRes.text();
      // let's do a regex search for "/api/"
      // find any occurrences of "/api/" or "api/search/" or anything like it
      const matches = text.match(/\/api\/[a-zA-Z0-9_/.-]+/g);
      if (matches) {
        console.log('API URLs found in:', url, matches.slice(0, 5));
      }
    } catch (e) {
      console.log('Err:', url, e.message);
    }
  }
}

run();
