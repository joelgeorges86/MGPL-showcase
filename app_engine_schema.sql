-- PostgreSQL / SQLite compatible schema for Joel Games Catalog Ultimate App Engine

-- PostgreSQL DDL

CREATE TABLE IF NOT EXISTS "AppGames" (
  "GameID" TEXT PRIMARY KEY,
  "Game Title" TEXT,
  "Primary Genre" TEXT,
  "Original Game Release Date" DATE,
  "Storage Size" TEXT,
  "Estimated Game Time" TEXT,
  "ROG Ally Playability" TEXT,
  "Laptop Playability" TEXT,
  "Min RAM GB" INTEGER,
  "Min VRAM GB" INTEGER,
  "SSD Required?" BOOLEAN,
  "Is RPG" BOOLEAN,
  "Is Turn-Based" BOOLEAN,
  "Is Action" BOOLEAN,
  "Is Strategy / Tactics" BOOLEAN,
  "Is Sim / Management" BOOLEAN,
  "Is Roguelike / Deckbuilder" BOOLEAN,
  "Is Shooter / FPS" BOOLEAN,
  "Is Platformer / Metroidvania" BOOLEAN,
  "Is Story / Narrative" BOOLEAN,
  "Is Sports / Racing" BOOLEAN,
  "Is Horror / Survival" BOOLEAN,
  "Official Website URL" TEXT,
  "Nexus Availability" TEXT,
  "Nexus Mods URL" TEXT,
  "Active" BOOLEAN,
  "Date Added" DATE,
  "Last Modified" DATE
);

CREATE TABLE IF NOT EXISTS "AppOwnership" (
  "OwnershipID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Platform" TEXT,
  "Store URL" TEXT,
  "Platform Specific Release Date" DATE,
  "Platform DLC Search URL" TEXT,
  "Edition" TEXT,
  "Format" TEXT,
  "Ownership Access Type" TEXT,
  "Purchase Date" DATE,
  "Price Paid" DOUBLE PRECISION,
  "Currency" TEXT,
  "Preferred Platform?" BOOLEAN,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppOwnership_GameID" ON "AppOwnership"("GameID");

CREATE TABLE IF NOT EXISTS "AppTracking" (
  "GameID" TEXT PRIMARY KEY,
  "Play Status" TEXT,
  "Want to Play?" BOOLEAN,
  "Personal Rating (1-10)" INTEGER,
  "Hours Played" DOUBLE PRECISION,
  "Last Played Date" DATE,
  "Played Platform" TEXT,
  "Played Hardware Device" TEXT,
  "Completed Date" DATE,
  "Replay Interest" TEXT,
  "DLC Status" TEXT,
  "Personal Review" TEXT,
  "Notes" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "AppReviews" (
  "ReviewID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Review Source" TEXT,
  "Review Summary / Score" TEXT,
  "Score Numeric" INTEGER,
  "Recommendation Percent" INTEGER,
  "Worth Playing Grade" TEXT,
  "Review URL" TEXT,
  "Verification Status" TEXT,
  "Last Checked Date" DATE,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppReviews_GameID" ON "AppReviews"("GameID");

CREATE TABLE IF NOT EXISTS "AppDLCs" (
  "DLC_ID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Game Title" TEXT,
  "DLC Availability Status" TEXT,
  "DLC Type" TEXT,
  "Owned Status" TEXT,
  "Store DLC Search URL" TEXT,
  "Expansion & DLC Notes" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppDLCs_GameID" ON "AppDLCs"("GameID");

CREATE TABLE IF NOT EXISTS "AppGameSettings" (
  "SettingID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Game Title" TEXT,
  "Hardware Profile" TEXT,
  "Target Resolution" TEXT,
  "Target Framerate" TEXT,
  "Preset Level" TEXT,
  "Upscaling / Frame Gen Setting" TEXT,
  "VRAM Allocation" TEXT,
  "Thermal / Power Mode" TEXT,
  "Recommended Game Settings & Tuning Notes" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppGameSettings_GameID" ON "AppGameSettings"("GameID");

CREATE TABLE IF NOT EXISTS "AppGameFriction" (
  "FrictionID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Game Title" TEXT,
  "Save System Type" TEXT,
  "Avg Time Between Saves" TEXT,
  "Suspend / Pause Friendly?" BOOLEAN,
  "Core Session Loop Length" TEXT,
  "Cognitive / Mental Energy Required" TEXT,
  "Third-Party Launcher Required?" TEXT,
  "Always-Online Required?" BOOLEAN,
  "Handheld Font & UI Legibility" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppGameFriction_GameID" ON "AppGameFriction"("GameID");

CREATE TABLE IF NOT EXISTS "AppCompletionRoadmap" (
  "RoadmapID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Game Title" TEXT,
  "Main Story Time" TEXT,
  "Missable Content / Trophies?" TEXT,
  "Min Playthroughs for 100%" TEXT,
  "Estimated 100% Completion Time" TEXT,
  "Trophy / Platinum Difficulty" TEXT,
  "Trophy Roadmap & Guide URL" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppCompletionRoadmap_GameID" ON "AppCompletionRoadmap"("GameID");

-- SQLite DDL (compatible with the same logical model)

CREATE TABLE IF NOT EXISTS "AppGames" (
  "GameID" TEXT PRIMARY KEY,
  "Game Title" TEXT,
  "Primary Genre" TEXT,
  "Original Game Release Date" TEXT,
  "Storage Size" TEXT,
  "Estimated Game Time" TEXT,
  "ROG Ally Playability" TEXT,
  "Laptop Playability" TEXT,
  "Min RAM GB" INTEGER,
  "Min VRAM GB" INTEGER,
  "SSD Required?" BOOLEAN,
  "Is RPG" BOOLEAN,
  "Is Turn-Based" BOOLEAN,
  "Is Action" BOOLEAN,
  "Is Strategy / Tactics" BOOLEAN,
  "Is Sim / Management" BOOLEAN,
  "Is Roguelike / Deckbuilder" BOOLEAN,
  "Is Shooter / FPS" BOOLEAN,
  "Is Platformer / Metroidvania" BOOLEAN,
  "Is Story / Narrative" BOOLEAN,
  "Is Sports / Racing" BOOLEAN,
  "Is Horror / Survival" BOOLEAN,
  "Official Website URL" TEXT,
  "Nexus Availability" TEXT,
  "Nexus Mods URL" TEXT,
  "Active" BOOLEAN,
  "Date Added" TEXT,
  "Last Modified" TEXT
);

CREATE TABLE IF NOT EXISTS "AppOwnership" (
  "OwnershipID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Platform" TEXT,
  "Store URL" TEXT,
  "Platform Specific Release Date" TEXT,
  "Platform DLC Search URL" TEXT,
  "Edition" TEXT,
  "Format" TEXT,
  "Ownership Access Type" TEXT,
  "Purchase Date" TEXT,
  "Price Paid" REAL,
  "Currency" TEXT,
  "Preferred Platform?" BOOLEAN,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppOwnership_GameID" ON "AppOwnership"("GameID");

CREATE TABLE IF NOT EXISTS "AppTracking" (
  "GameID" TEXT PRIMARY KEY,
  "Play Status" TEXT,
  "Want to Play?" BOOLEAN,
  "Personal Rating (1-10)" INTEGER,
  "Hours Played" REAL,
  "Last Played Date" TEXT,
  "Played Platform" TEXT,
  "Played Hardware Device" TEXT,
  "Completed Date" TEXT,
  "Replay Interest" TEXT,
  "DLC Status" TEXT,
  "Personal Review" TEXT,
  "Notes" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "AppReviews" (
  "ReviewID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Review Source" TEXT,
  "Review Summary / Score" TEXT,
  "Score Numeric" INTEGER,
  "Recommendation Percent" INTEGER,
  "Worth Playing Grade" TEXT,
  "Review URL" TEXT,
  "Verification Status" TEXT,
  "Last Checked Date" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppReviews_GameID" ON "AppReviews"("GameID");

CREATE TABLE IF NOT EXISTS "AppDLCs" (
  "DLC_ID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Game Title" TEXT,
  "DLC Availability Status" TEXT,
  "DLC Type" TEXT,
  "Owned Status" TEXT,
  "Store DLC Search URL" TEXT,
  "Expansion & DLC Notes" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppDLCs_GameID" ON "AppDLCs"("GameID");

CREATE TABLE IF NOT EXISTS "AppGameSettings" (
  "SettingID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Game Title" TEXT,
  "Hardware Profile" TEXT,
  "Target Resolution" TEXT,
  "Target Framerate" TEXT,
  "Preset Level" TEXT,
  "Upscaling / Frame Gen Setting" TEXT,
  "VRAM Allocation" TEXT,
  "Thermal / Power Mode" TEXT,
  "Recommended Game Settings & Tuning Notes" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppGameSettings_GameID" ON "AppGameSettings"("GameID");

CREATE TABLE IF NOT EXISTS "AppGameFriction" (
  "FrictionID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Game Title" TEXT,
  "Save System Type" TEXT,
  "Avg Time Between Saves" TEXT,
  "Suspend / Pause Friendly?" BOOLEAN,
  "Core Session Loop Length" TEXT,
  "Cognitive / Mental Energy Required" TEXT,
  "Third-Party Launcher Required?" TEXT,
  "Always-Online Required?" BOOLEAN,
  "Handheld Font & UI Legibility" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppGameFriction_GameID" ON "AppGameFriction"("GameID");

CREATE TABLE IF NOT EXISTS "AppCompletionRoadmap" (
  "RoadmapID" TEXT PRIMARY KEY,
  "GameID" TEXT NOT NULL,
  "Game Title" TEXT,
  "Main Story Time" TEXT,
  "Missable Content / Trophies?" TEXT,
  "Min Playthroughs for 100%" TEXT,
  "Estimated 100% Completion Time" TEXT,
  "Trophy / Platinum Difficulty" TEXT,
  "Trophy Roadmap & Guide URL" TEXT,
  FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_AppCompletionRoadmap_GameID" ON "AppCompletionRoadmap"("GameID");
