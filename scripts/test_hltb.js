const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function run() {
  try {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    
    // 1. Initialize search security
    console.log('Initializing search security...');
    const initRes = await globalThis.fetch('https://howlongtobeat.com/api/bleed/init?t=' + Date.now(), {
      headers: {
        'User-Agent': userAgent,
        'Referer': 'https://howlongtobeat.com/'
      }
    });
    
    if (!initRes.ok) {
      console.error('Failed to init search security:', initRes.status, await initRes.text());
      return;
    }
    
    const initData = await initRes.json();
    console.log('Init Data:', initData);
    
    const { token, hpKey, hpVal } = initData;
    
    // 2. Perform search
    const body = {
      searchType: 'games',
      searchTerms: ['Portal'],
      searchPage: 1,
      size: 20,
      searchOptions: {
        games: {
          userId: 0,
          platform: '',
          sortCategory: 'popular',
          rangeCategory: 'main',
          rangeTime: { min: null, max: null },
          gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
          rangeYear: { min: '', max: '' },
          modifier: ''
        },
        users: { sortCategory: 'postcount' },
        lists: { sortCategory: 'follows' },
        filter: '',
        sortCategory: 'popular',
        randomizer: 0
      },
      useCache: true
    };

    // Add the dynamic key-value pair to the body!
    if (hpKey && hpVal) {
      body[hpKey] = hpVal;
    }

    console.log('Searching HLTB for Portal with body keys:', Object.keys(body));
    const searchRes = await globalThis.fetch('https://howlongtobeat.com/api/bleed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        'Referer': 'https://howlongtobeat.com/',
        'x-auth-token': token,
        'x-hp-key': hpKey,
        'x-hp-val': hpVal
      },
      body: JSON.stringify(body)
    });
    
    if (!searchRes.ok) {
      console.error('Search failed:', searchRes.status, await searchRes.text());
      return;
    }
    
    const searchResult = await searchRes.json();
    console.log('Search Result status:', searchRes.status);
    console.log('First search item name:', searchResult.data?.[0]?.game_name);
    console.log('Gameplay Main hours:', searchResult.data?.[0]?.comp_main / 3600); 
    console.log('Gameplay Comp hours:', searchResult.data?.[0]?.comp_all / 3600);
    console.log('All first game data:', JSON.stringify(searchResult.data?.[0]).slice(0, 1000));
  } catch (err) {
    console.error('Error running test:', err);
  }
}

run();
