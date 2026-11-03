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
      const idx = text.indexOf('/api/search');
      if (idx !== -1) {
        console.log('FOUND /api/search in:', url);
        console.log('Context:', text.slice(idx - 100, idx + 300));
      }
      
      const idx2 = text.indexOf('api/search');
      if (idx2 !== -1) {
        console.log('FOUND api/search in:', url);
        console.log('Context:', text.slice(idx2 - 100, idx2 + 300));
      }
    } catch (e) {
      console.log('Err:', url, e.message);
    }
  }
}

run();
