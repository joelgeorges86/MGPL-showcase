import { Router } from 'express';
import { db } from '../db';

const router = Router();

const parseMentalEnergy = (value: string): 'low' | 'moderate' | 'high' => {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('low')) return 'low';
  if (normalized.includes('high')) return 'high';
  return 'moderate';
};

const cognitiveFilters = (energy: 'low' | 'moderate' | 'high') => {
  switch (energy) {
    case 'low':
      return {
        OR: [
          { cognitiveMentalEnergyRequired: { contains: 'low' } },
          { cognitiveMentalEnergyRequired: { contains: 'moderate' } },
        ],
      };
    case 'moderate':
      return {
        OR: [
          { cognitiveMentalEnergyRequired: { contains: 'low' } },
          { cognitiveMentalEnergyRequired: { contains: 'moderate' } },
          { cognitiveMentalEnergyRequired: { contains: 'high' } },
        ],
      };
    case 'high':
      return {
        OR: [
          { cognitiveMentalEnergyRequired: { contains: 'moderate' } },
          { cognitiveMentalEnergyRequired: { contains: 'high' } },
        ],
      };
  }
};

const parseSessionLength = (length: string): number | null => {
  const match = length.match(/(\d+)(?:\s*-\s*(\d+))?/i);
  if (!match) return null;
  const minValue = Number(match[1]);
  const maxValue = match[2] ? Number(match[2]) : minValue;
  if (Number.isNaN(minValue) || Number.isNaN(maxValue)) return null;
  return Math.min(minValue, maxValue);
};

router.get('/', async (req, res, next) => {
  try {
    const minutesQuery = req.query.minutes;
    const mentalEnergyQuery = req.query.mentalEnergy;
    const hardwareDeviceQuery = req.query.hardwareDevice;
    const playTimeQuery = req.query.playTime; // e.g. "Under 10 Hours", "10-25 Hours", "Epics 50+ Hours"
    const rogAllyPlayabilityQuery = req.query.rogAllyPlayability; // e.g. "Ideal", "Fully Playable"

    const availableMinutes = typeof minutesQuery === 'string' ? Number(minutesQuery) : 60;
    if (Number.isNaN(availableMinutes) || availableMinutes <= 0) {
      return res.status(400).json({ error: 'minutes must be a positive number' });
    }

    const mentalEnergy = mentalEnergyQuery && typeof mentalEnergyQuery === 'string'
      ? parseMentalEnergy(mentalEnergyQuery)
      : 'moderate';

    const hardwareDevice = typeof hardwareDeviceQuery === 'string' ? hardwareDeviceQuery.trim() : undefined;
    const playTime = typeof playTimeQuery === 'string' ? playTimeQuery.trim() : undefined;
    const rogAllyPlayability = typeof rogAllyPlayabilityQuery === 'string' ? rogAllyPlayabilityQuery.trim() : undefined;

    // Raw SQL equivalent of the former Prisma appGame.findMany query:
    //   frictions: { some: cognitiveFilters(mentalEnergy) }   → EXISTS subquery
    //   settings:  { some: { hardwareProfile: { contains } } } → EXISTS subquery
    // Numeric parsing/filtering still happens in JS below to avoid SQLite
    // conversion errors on text-typed requirement columns.
    const cognitiveTerms = cognitiveFilters(mentalEnergy).OR as Array<{
      cognitiveMentalEnergyRequired: { contains: string };
    }>;
    const frictionWhere = cognitiveTerms
      .map(() => `f."Cognitive / Mental Energy Required" LIKE ?`)
      .join(' OR ');
    const frictionParams = cognitiveTerms.map((t) => `%${t.cognitiveMentalEnergyRequired.contains}%`);

    const settingsParams: string[] = [];
    let settingsExists = '';
    if (hardwareDevice) {
      settingsExists =
        ' AND EXISTS (SELECT 1 FROM AppGameSettings s WHERE s."GameID" = g."GameID" AND s."Hardware Profile" LIKE ?)';
      settingsParams.push(`%${hardwareDevice}%`);
    }

    const rows = db
      .prepare(
        `SELECT g."GameID" AS gameID, g."Game Title" AS gameTitle,
                g."Min RAM GB" AS minRamGb, g."Min VRAM GB" AS minVramGb,
                g."Estimated Game Time" AS estimatedGameTime, g."ROG Ally Playability" AS rogAllyPlayability
         FROM AppGames g
         WHERE (${frictionWhere}) ${settingsExists}
         LIMIT 500`,
      )
      .all(...frictionParams, ...settingsParams) as any[];

    // Load the same relations Prisma included (frictions, settings,
    // completionRoadmaps) in bulk and group by gameID.
    const gameIds = rows.map((r) => r.gameID);
    const frictionsByGame = new Map<string, any[]>();
    const settingsByGame = new Map<string, any[]>();
    const roadmapsByGame = new Map<string, any[]>();
    if (gameIds.length > 0) {
      const placeholders = gameIds.map(() => '?').join(', ');
      const frictionRows = db
        .prepare(
          `SELECT "GameID" AS gameID, "Core Session Loop Length" AS coreSessionLoopLength,
                  "Cognitive / Mental Energy Required" AS cognitiveMentalEnergyRequired
           FROM AppGameFriction WHERE "GameID" IN (${placeholders})`,
        )
        .all(...gameIds) as any[];
      for (const f of frictionRows) {
        if (!frictionsByGame.has(f.gameID)) frictionsByGame.set(f.gameID, []);
        frictionsByGame.get(f.gameID)!.push(f);
      }

      const settingRows = db
        .prepare(
          `SELECT "GameID" AS gameID, "Hardware Profile" AS hardwareProfile,
                  "Target Resolution" AS targetResolution
           FROM AppGameSettings WHERE "GameID" IN (${placeholders})`,
        )
        .all(...gameIds) as any[];
      for (const s of settingRows) {
        if (!settingsByGame.has(s.gameID)) settingsByGame.set(s.gameID, []);
        settingsByGame.get(s.gameID)!.push(s);
      }

      const roadmapRows = db
        .prepare(
          `SELECT "GameID" AS gameID, "main_story_hours" AS main_story_hours,
                  "completionist_hours" AS completionist_hours, "Main Story Time" AS mainStoryTime
           FROM AppCompletionRoadmap WHERE "GameID" IN (${placeholders})`,
        )
        .all(...gameIds) as any[];
      for (const r of roadmapRows) {
        if (!roadmapsByGame.has(r.gameID)) roadmapsByGame.set(r.gameID, []);
        roadmapsByGame.get(r.gameID)!.push(r);
      }
    }

    // Reassemble the Prisma include shape so the downstream mapping is unchanged.
    const results = rows.map((g) => ({
      ...g,
      frictions: frictionsByGame.get(g.gameID) || [],
      settings: settingsByGame.get(g.gameID) || [],
      completionRoadmaps: roadmapsByGame.get(g.gameID) || [],
    }));

    // Helper to parse integer values from strings like "4 GB" or "~8GB" safely
    const parseNumberFromString = (raw?: string | null): number | null => {
      if (!raw || typeof raw !== 'string') return null;
      const digits = raw.replace(/[^0-9.]/g, '');
      if (!digits) return null;
      const n = parseFloat(digits);
      return Number.isNaN(n) ? null : n;
    };

    const matches = results
      .map((game: any) => {
        const bestFriction = game.frictions?.[0];
        const sessionMinutes = bestFriction ? parseSessionLength(bestFriction.coreSessionLoopLength ?? '') : null;

        // parse numeric-like fields from text
        const parsedMinRam = typeof game.minRamGb === 'number' ? game.minRamGb : parseNumberFromString(typeof game.minRamGb === 'string' ? game.minRamGb : null);
        const parsedMinVram = typeof game.minVramGb === 'number' ? game.minVramGb : parseNumberFromString(typeof game.minVramGb === 'string' ? game.minVramGb : null);

        // Get main story hours estimate from SQLite new columns, or fallback to text parsing
        const roadmap = game.completionRoadmaps?.[0] as any;
        let mainStoryHours = roadmap?.main_story_hours ?? null;
        if (mainStoryHours === null && roadmap?.mainStoryTime) {
          mainStoryHours = parseNumberFromString(roadmap.mainStoryTime);
        }
        if (mainStoryHours === null) {
          mainStoryHours = parseNumberFromString(game.estimatedGameTime);
        }

        const completionistHours = roadmap?.completionist_hours ?? null;

        return {
          gameId: game.gameID,
          title: game.gameTitle,
          coreSessionLoopLength: bestFriction?.coreSessionLoopLength,
          cognitiveMentalEnergyRequired: bestFriction?.cognitiveMentalEnergyRequired,
          hardwareProfiles: game.settings?.map((setting: any) => setting.hardwareProfile).filter(Boolean),
          rogAllyPlayability: game.rogAllyPlayability,
          sessionMinutes,
          parsedMinRam,
          parsedMinVram,
          mainStoryHours,
          completionistHours,
        };
      })
      // filter by session length in JS memory
      .filter((candidate: any) => candidate.sessionMinutes !== null && candidate.sessionMinutes <= availableMinutes)
      // filter by playtime (mainStoryHours)
      .filter((candidate: any) => {
        if (!playTime) return true;
        const hours = candidate.mainStoryHours;
        if (hours === null) return false; // exclude if no playtime info is available and range filtering is requested
        
        const normalizedPlayTime = playTime.toLowerCase();
        if (normalizedPlayTime.includes('under 10')) {
          return hours < 10;
        } else if (normalizedPlayTime.includes('10-25')) {
          return hours >= 10 && hours <= 25;
        } else if (normalizedPlayTime.includes('50+')) {
          return hours >= 50;
        } else if (normalizedPlayTime.includes('25-50')) {
          return hours >= 25 && hours <= 50;
        }
        return true;
      })
      // filter by ROG Ally playability tags
      .filter((candidate: any) => {
        if (!rogAllyPlayability) return true;
        return candidate.rogAllyPlayability?.toLowerCase().includes(rogAllyPlayability.toLowerCase());
      })
      .sort((a: any, b: any) => (a.sessionMinutes || 0) - (b.sessionMinutes || 0));

    res.json({ 
      query: { 
        availableMinutes, 
        mentalEnergy, 
        hardwareDevice: hardwareDevice || null,
        playTime: playTime || null,
        rogAllyPlayability: rogAllyPlayability || null
      }, 
      matches 
    });
  } catch (error) {
    next(error);
  }
});

export default router;
