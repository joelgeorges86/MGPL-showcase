import axios from 'axios';
import * as dotenv from 'dotenv';
import {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  getUserTitles,
} from 'psn-api';

// Load environmental variables
dotenv.config();

async function runTests() {
  console.log('==================================================');
  console.log('   EXTERNAL API INTEGRATION TEST SUITE           ');
  console.log('==================================================\n');

  // 1. Steam API Test
  try {
    const steamKey = process.env.STEAM_API_KEY;
    const steamId = process.env.STEAM_ID64;

    if (!steamKey || !steamId) {
      throw new Error('STEAM_API_KEY or STEAM_ID64 missing in .env');
    }

    const url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/';
    const res = await axios.get<any>(url, {
      params: {
        key: steamKey,
        steamid: steamId,
        format: 'json',
      },
    });

    const gameCount = res.data?.response?.game_count;
    const games = res.data?.response?.games || [];
    
    if (gameCount !== undefined || games.length > 0) {
      const finalCount = gameCount !== undefined ? gameCount : games.length;
      console.log(`[PASS] Steam API: Successfully fetched owned games. Count: ${finalCount}`);
    } else {
      throw new Error('Response received, but games list is empty or invalid.');
    }
  } catch (err: any) {
    console.error(`[FAIL] Steam API: ${err.message}`, err.response?.data || '');
  }

  console.log('--------------------------------------------------');

  // 2. IGDB API Test
  try {
    const twitchClientId = process.env.TWITCH_CLIENT_ID;
    const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;

    if (!twitchClientId || !twitchClientSecret) {
      throw new Error('TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET missing in .env');
    }

    // A. Request OAuth Token
    const tokenUrl = 'https://id.twitch.tv/oauth2/token';
    const tokenRes = await axios.post<any>(tokenUrl, null, {
      params: {
        client_id: twitchClientId,
        client_secret: twitchClientSecret,
        grant_type: 'client_credentials',
      },
    });

    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      throw new Error('OAuth token request succeeded but access_token is empty.');
    }

    // B. Search for a game title on IGDB
    const gamesUrl = 'https://api.igdb.com/v4/games';
    const igdbRes = await axios.post<any>(
      gamesUrl,
      'search "The Witcher"; fields name; limit 1;',
      {
        headers: {
          'Client-ID': twitchClientId,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'text/plain',
        },
      }
    );

    if (Array.isArray(igdbRes.data) && igdbRes.data.length > 0) {
      console.log(`[PASS] IGDB API: Token acquired. Search for "The Witcher" returned: "${igdbRes.data[0]?.name}"`);
    } else if (Array.isArray(igdbRes.data)) {
      console.log(`[PASS] IGDB API: Token acquired. Search returned 0 results.`);
    } else {
      throw new Error('Invalid response data received from IGDB games endpoint.');
    }
  } catch (err: any) {
    console.error(`[FAIL] IGDB API: ${err.message}`, err.response?.data || '');
  }

  console.log('--------------------------------------------------');

  // 3. IsThereAnyDeal API Test
  try {
    const itadKey = process.env.ITAD_API_KEY;

    if (!itadKey) {
      throw new Error('ITAD_API_KEY missing in .env');
    }

    const url = 'https://api.isthereanydeal.com/deals/v2?country=US&limit=1';
    const res = await axios.get<any>(url, {
      headers: {
        'ITAD-API-Key': itadKey,
      },
    });

    if (res.data) {
      console.log('[PASS] IsThereAnyDeal API: Successfully requested deals list.');
    } else {
      throw new Error('Empty response body.');
    }
  } catch (err: any) {
    console.error(`[FAIL] IsThereAnyDeal API: ${err.message}`, err.response?.data || '');
  }

  console.log('--------------------------------------------------');

  // 4. Nexus Mods API Test
  try {
    const nexusKey = process.env.NEXUS_MODS_API_KEY || process.env.NEXUSMODS_API_KEY;

    if (!nexusKey) {
      throw new Error('NEXUS_MODS_API_KEY or NEXUSMODS_API_KEY missing in .env');
    }

    const url = 'https://api.nexusmods.com/v1/users/validate.json';
    const res = await axios.get<any>(url, {
      headers: {
        'apikey': nexusKey,
      },
    });

    if (res.data?.name) {
      console.log(`[PASS] Nexus Mods API: Successfully validated. User: ${res.data.name}`);
    } else {
      throw new Error('Validation succeeded, but username is missing in response.');
    }
  } catch (err: any) {
    console.error(`[FAIL] Nexus Mods API: ${err.message}`, err.response?.data || '');
  }

  console.log('--------------------------------------------------');

  // 5. PSN API Test
  try {
    const npssoToken = process.env.PSN_NPSSO_TOKEN || process.env.PSN_NPSSO_CODE;

    if (!npssoToken) {
      throw new Error('PSN_NPSSO_TOKEN or PSN_NPSSO_CODE missing in .env');
    }

    // Exchange NPSSO Token for Access Code
    const accessCode = await exchangeNpssoForAccessCode(npssoToken);
    
    // Exchange Access Code for Auth Tokens
    const authorization = await exchangeAccessCodeForAuthTokens(accessCode);
    
    // Get User Titles
    const titlesResponse = await getUserTitles(authorization, 'me');
    const titlesCount = titlesResponse?.trophyTitles?.length || 0;

    console.log(`[PASS] PSN API: Successfully authenticated. Title count: ${titlesCount}`);
  } catch (err: any) {
    console.error(`[FAIL] PSN API: ${err.message}`);
  }

  console.log('\n==================================================');
  console.log('   TEST RUN COMPLETED                             ');
  console.log('==================================================');
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
});
