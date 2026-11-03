import re
import sqlite3
from pathlib import Path
from typing import List, Sequence, Tuple

import pandas as pd

WORKBOOK_PATH = Path(r'C:/Users/joelg/OneDrive/PC Build/Gaming/Joel_Games_Catalog_Ultimate_App_Engine.xlsx')
OUTPUT_DB = Path('mpgl_app.db')

TABLE_DEFINITIONS = {
    'AppGames': {
        'sheet_name': 'App Games',
        'columns': [
            'GameID', 'Game Title', 'Primary Genre', 'Original Game Release Date', 'Storage Size',
            'Estimated Game Time', 'ROG Ally Playability', 'Laptop Playability', 'Min RAM GB',
            'Min VRAM GB', 'SSD Required?', 'Is RPG', 'Is Turn-Based', 'Is Action',
            'Is Strategy / Tactics', 'Is Sim / Management', 'Is Roguelike / Deckbuilder',
            'Is Shooter / FPS', 'Is Platformer / Metroidvania', 'Is Story / Narrative',
            'Is Sports / Racing', 'Is Horror / Survival', 'Official Website URL', 'Nexus Availability',
            'Nexus Mods URL', 'Active', 'Date Added', 'Last Modified',
        ],
    },
    'AppOwnership': {
        'sheet_name': 'App Ownership',
        'columns': [
            'OwnershipID', 'GameID', 'Platform', 'Store URL', 'Platform Specific Release Date',
            'Platform DLC Search URL', 'Edition', 'Format', 'Ownership Access Type', 'Purchase Date',
            'Price Paid', 'Currency', 'Preferred Platform?',
        ],
    },
    'AppTracking': {
        'sheet_name': 'App Tracking',
        'columns': [
            'GameID', 'Play Status', 'Want to Play?', 'Personal Rating (1-10)', 'Hours Played',
            'Last Played Date', 'Played Platform', 'Played Hardware Device', 'Completed Date',
            'Replay Interest', 'DLC Status', 'Personal Review', 'Notes',
        ],
    },
    'AppReviews': {
        'sheet_name': 'App Reviews',
        'columns': [
            'ReviewID', 'GameID', 'Review Source', 'Review Summary / Score', 'Score Numeric',
            'Recommendation Percent', 'Worth Playing Grade', 'Review URL', 'Verification Status',
            'Last Checked Date',
        ],
    },
    'AppDLCs': {
        'sheet_name': 'App DLCs',
        'columns': [
            'DLC_ID', 'GameID', 'Game Title', 'DLC Availability Status', 'DLC Type', 'Owned Status',
            'Store DLC Search URL', 'Expansion & DLC Notes',
        ],
    },
    'AppGameSettings': {
        'sheet_name': 'AppGameSettings',
        'columns': [
            'SettingID', 'GameID', 'Game Title', 'Hardware Profile', 'Target Resolution',
            'Target Framerate', 'Preset Level', 'Upscaling / Frame Gen Setting', 'VRAM Allocation',
            'Thermal / Power Mode', 'Recommended Game Settings & Tuning Notes',
        ],
    },
    'AppGameFriction': {
        'sheet_name': 'AppGameFriction',
        'columns': [
            'FrictionID', 'GameID', 'Game Title', 'Save System Type', 'Avg Time Between Saves',
            'Suspend / Pause Friendly?', 'Core Session Loop Length', 'Cognitive / Mental Energy Required',
            'Third-Party Launcher Required?', 'Always-Online Required?', 'Handheld Font & UI Legibility',
        ],
    },
    'AppCompletionRoadmap': {
        'sheet_name': 'AppCompletionRoadmap',
        'columns': [
            'RoadmapID', 'GameID', 'Game Title', 'Main Story Time', 'Missable Content / Trophies?',
            'Min Playthroughs for 100%', 'Estimated 100% Completion Time', 'Trophy / Platinum Difficulty',
            'Trophy Roadmap & Guide URL',
        ],
    },
}

CREATE_STATEMENTS = {
    'AppGames': '''
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
  "SSD Required?" TEXT,
  "Is RPG" TEXT,
  "Is Turn-Based" TEXT,
  "Is Action" TEXT,
  "Is Strategy / Tactics" TEXT,
  "Is Sim / Management" TEXT,
  "Is Roguelike / Deckbuilder" TEXT,
  "Is Shooter / FPS" TEXT,
  "Is Platformer / Metroidvania" TEXT,
  "Is Story / Narrative" TEXT,
  "Is Sports / Racing" TEXT,
  "Is Horror / Survival" TEXT,
  "Official Website URL" TEXT,
  "Nexus Availability" TEXT,
  "Nexus Mods URL" TEXT,
  "Active" TEXT,
  "Date Added" TEXT,
  "Last Modified" TEXT
);
''',
    'AppOwnership': '''
CREATE TABLE IF NOT EXISTS "AppOwnership" (
  "OwnershipID" TEXT PRIMARY KEY,
  "GameID" TEXT,
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
  "Preferred Platform?" TEXT
);
''',
    'AppTracking': '''
CREATE TABLE IF NOT EXISTS "AppTracking" (
  "GameID" TEXT PRIMARY KEY,
  "Play Status" TEXT,
  "Want to Play?" TEXT,
  "Personal Rating (1-10)" INTEGER,
  "Hours Played" REAL,
  "Last Played Date" TEXT,
  "Played Platform" TEXT,
  "Played Hardware Device" TEXT,
  "Completed Date" TEXT,
  "Replay Interest" TEXT,
  "DLC Status" TEXT,
  "Personal Review" TEXT,
  "Notes" TEXT
);
''',
    'AppReviews': '''
CREATE TABLE IF NOT EXISTS "AppReviews" (
  "ReviewID" TEXT PRIMARY KEY,
  "GameID" TEXT,
  "Review Source" TEXT,
  "Review Summary / Score" TEXT,
  "Score Numeric" INTEGER,
  "Recommendation Percent" INTEGER,
  "Worth Playing Grade" TEXT,
  "Review URL" TEXT,
  "Verification Status" TEXT,
  "Last Checked Date" TEXT
);
''',
    'AppDLCs': '''
CREATE TABLE IF NOT EXISTS "AppDLCs" (
  "DLC_ID" TEXT PRIMARY KEY,
  "GameID" TEXT,
  "Game Title" TEXT,
  "DLC Availability Status" TEXT,
  "DLC Type" TEXT,
  "Owned Status" TEXT,
  "Store DLC Search URL" TEXT,
  "Expansion & DLC Notes" TEXT
);
''',
    'AppGameSettings': '''
CREATE TABLE IF NOT EXISTS "AppGameSettings" (
  "SettingID" TEXT PRIMARY KEY,
  "GameID" TEXT,
  "Game Title" TEXT,
  "Hardware Profile" TEXT,
  "Target Resolution" TEXT,
  "Target Framerate" TEXT,
  "Preset Level" TEXT,
  "Upscaling / Frame Gen Setting" TEXT,
  "VRAM Allocation" TEXT,
  "Thermal / Power Mode" TEXT,
  "Recommended Game Settings & Tuning Notes" TEXT
);
''',
    'AppGameFriction': '''
CREATE TABLE IF NOT EXISTS "AppGameFriction" (
  "FrictionID" TEXT PRIMARY KEY,
  "GameID" TEXT,
  "Game Title" TEXT,
  "Save System Type" TEXT,
  "Avg Time Between Saves" TEXT,
  "Suspend / Pause Friendly?" TEXT,
  "Core Session Loop Length" TEXT,
  "Cognitive / Mental Energy Required" TEXT,
  "Third-Party Launcher Required?" TEXT,
  "Always-Online Required?" TEXT,
  "Handheld Font & UI Legibility" TEXT
);
''',
    'AppCompletionRoadmap': '''
CREATE TABLE IF NOT EXISTS "AppCompletionRoadmap" (
  "RoadmapID" TEXT PRIMARY KEY,
  "GameID" TEXT,
  "Game Title" TEXT,
  "Main Story Time" TEXT,
  "Missable Content / Trophies?" TEXT,
  "Min Playthroughs for 100%" TEXT,
  "Estimated 100% Completion Time" TEXT,
  "Trophy / Platinum Difficulty" TEXT,
  "Trophy Roadmap & Guide URL" TEXT
);
''',
    'AppGenres': '''
CREATE TABLE IF NOT EXISTS "AppGenres" (
  "GenreID" INTEGER PRIMARY KEY AUTOINCREMENT,
  "GenreName" TEXT UNIQUE NOT NULL
);
''',
    'AppGameGenreMap': '''
CREATE TABLE IF NOT EXISTS "AppGameGenreMap" (
  "GameID" TEXT NOT NULL,
  "GenreID" INTEGER NOT NULL,
  PRIMARY KEY ("GameID", "GenreID")
);
''',
}


# ---------------------------------------------------------------------------
# Granular Steam-style genre taxonomy
#
# The workbook only carries 14 broad composite buckets in "Primary Genre"
# (e.g. "RPG / JRPG"), which is why western RPGs such as Dragon Age and Fallout
# were picking up a "JRPG" label. Tags are resolved in three layers:
#
#   1. TITLE_TAG_OVERRIDES  - curated per-franchise Steam tags (highest priority)
#   2. BUCKET_TAGS          - the composite bucket string, split into real tags
#   3. FLAG_TAGS            - the "Is ..." boolean columns, as broad enrichment
#
# Note: "JRPG" is never produced by layers 2 or 3. The "RPG / JRPG" bucket
# degrades to a plain "RPG" tag, so a title can only be labelled JRPG by an
# explicit curated entry below.
# ---------------------------------------------------------------------------

# Curated tag profiles.
WRPG_ACTION_TAGS = ['Action RPG', 'RPG', 'Open World', 'Story Rich']
WRPG_CRPG_TAGS = ['CRPG', 'RPG', 'Party-Based RPG', 'Turn-Based RPG', 'Story Rich']
JRPG_TURN_TAGS = ['JRPG', 'Turn-Based RPG', 'Party-Based RPG', 'RPG']
JRPG_ACTION_TAGS = ['JRPG', 'Action RPG', 'RPG', 'Story Rich']
CITY_BUILDER_TAGS = ['City Builder', 'Simulation', 'Management']
TACTICS_TAGS = ['Turn-Based Strategy', 'Tactical', 'Strategy', 'Turn-Based']
ACTION_ADVENTURE_TAGS = ['Action-Adventure', 'Story Rich', 'Puzzle', 'Atmospheric']

# Matched as case-insensitive substrings of the title, first match wins, so
# more specific keywords must come before the broader ones they contain.
TITLE_TAG_OVERRIDES = [
    # --- Western / action RPGs (never JRPG) ---
    ('dragon age', WRPG_ACTION_TAGS),
    ('fallout', WRPG_ACTION_TAGS),
    ('banishers', WRPG_ACTION_TAGS),
    ('elex', WRPG_ACTION_TAGS),
    ('the elder scrolls', WRPG_ACTION_TAGS),
    ('the witcher 2', WRPG_ACTION_TAGS),
    ('the witcher 3', WRPG_ACTION_TAGS),
    ('the witcher:', WRPG_ACTION_TAGS),
    ('greedfall', WRPG_ACTION_TAGS),
    ('kingdoms of amalur', WRPG_ACTION_TAGS),
    ('cat quest', ['Action RPG', 'RPG', 'Adventure']),
    ('dink smallwood', ['Action RPG', 'RPG', 'Adventure']),
    ('the thaumaturge', ['RPG', 'Story Rich', 'Turn-Based RPG', 'Atmospheric']),

    # --- Western party / isometric CRPGs ---
    ('pathfinder:', WRPG_CRPG_TAGS),
    ('wasteland 3', WRPG_CRPG_TAGS),
    ('warhammer 40,000: rogue trader', WRPG_CRPG_TAGS),
    ('expeditions:', WRPG_CRPG_TAGS),
    ('disciples:', ['Strategy', 'RPG', 'Turn-Based Strategy', 'Tactical']),
    ('eschalon', WRPG_CRPG_TAGS),
    ('ultima', WRPG_CRPG_TAGS),
    ('akalabeth', WRPG_CRPG_TAGS),
    ('shores unknown', ['Tactical', 'RPG', 'Turn-Based Strategy', 'Story Rich']),
    ('thronebreaker', ['RPG', 'Card Game', 'Story Rich', 'Turn-Based']),

    # --- Japanese RPGs ---
    ('persona 5 royal', JRPG_TURN_TAGS),
    ('eiyuden chronicle', JRPG_TURN_TAGS),
    ('digimon', JRPG_TURN_TAGS),
    ('octopath traveler', JRPG_TURN_TAGS),
    ('shin megami tensei', JRPG_TURN_TAGS),
    ('valkyria chronicles', ['JRPG', 'Tactical', 'Turn-Based Strategy', 'RPG', 'Story Rich']),
    ('yakuza: like a dragon', JRPG_TURN_TAGS),
    ('like a dragon: infinite wealth', JRPG_TURN_TAGS),
    ('like a dragon gaiden', JRPG_ACTION_TAGS),
    ('yakuza', JRPG_ACTION_TAGS),
    ('sword art online', JRPG_ACTION_TAGS),
    ('persona 5 strikers', JRPG_ACTION_TAGS),

    # --- City builders / simulation / management ---
    ('112 operator', CITY_BUILDER_TAGS),
    ('911 operator', CITY_BUILDER_TAGS),
    ('cities: skylines', CITY_BUILDER_TAGS),
    ('cities skylines', CITY_BUILDER_TAGS),

    # --- Turn-based tactics / strategy ---
    ('xcom', TACTICS_TAGS),

    # --- Action-adventure ---
    ('dungeons of hinterberg', ACTION_ADVENTURE_TAGS),
    ('a plague tale', ACTION_ADVENTURE_TAGS),
]

# The 14 composite buckets, expanded into granular tags.
BUCKET_TAGS = {
    'action / adventure': ['Action', 'Adventure', 'Action-Adventure'],
    'story / narrative / adventure': ['Story Rich', 'Narrative', 'Adventure', 'Atmospheric'],
    'rpg / jrpg': ['RPG'],
    'city builder / simulation / management': ['City Builder', 'Simulation', 'Management'],
    'strategy / turn-based / 4x': ['Strategy', 'Turn-Based Strategy', '4X', 'Turn-Based'],
    'casual / visual novel / adult': ['Casual', 'Visual Novel', 'Adult'],
    'action / hack & slash / fighting': ['Action', 'Hack and Slash', 'Fighting'],
    'roguelike / deckbuilder': ['Roguelike', 'Deckbuilder', 'Card Game'],
    'first-person shooter (fps)': ['FPS', 'Shooter', 'Action'],
    'horror / survival': ['Horror', 'Survival', 'Atmospheric'],
    'metroidvania / platformer': ['Metroidvania', 'Platformer', '2D'],
    'sports / racing': ['Sports', 'Racing'],
    'platformer / party / casual': ['Platformer', 'Party', 'Casual'],
    'cozy / life sim / puzzle': ['Cozy', 'Life Sim', 'Puzzle'],
}

# Broad single tags only - the bucket map above supplies the precise pairings,
# so these never assert the narrower half of an "A / B" column name.
FLAG_TAGS = {
    'Is RPG': ['RPG'],
    'Is Turn-Based': ['Turn-Based'],
    'Is Action': ['Action'],
    'Is Strategy / Tactics': ['Strategy'],
    'Is Sim / Management': ['Simulation'],
    'Is Roguelike / Deckbuilder': ['Roguelike'],
    'Is Shooter / FPS': ['Shooter'],
    'Is Platformer / Metroidvania': ['Platformer'],
    'Is Story / Narrative': ['Story Rich'],
    'Is Sports / Racing': ['Sports'],
    'Is Horror / Survival': ['Horror'],
}


def is_yes(value) -> bool:
    if value is None:
        return False
    try:
        if pd.isna(value):
            return False
    except (TypeError, ValueError):
        pass
    return str(value).strip().lower() in {'yes', 'y', 'true', '1'}


def split_genre_string(value) -> list:
    """Fallback split for bucket strings that are not in BUCKET_TAGS."""
    if value is None:
        return []
    text = str(value)
    parts = re.split(r'[/,|;]| & ', text)
    return [p.strip() for p in parts if p and p.strip()]


def derive_genre_tags(title, primary_genre, row) -> list:
    """Resolve one game's granular Steam tags. Order is preserved, no duplicates."""
    tags = []

    def add(names):
        for name in names:
            if name and name not in tags:
                tags.append(name)

    key = str(title or '').strip().lower()
    for keyword, profile in TITLE_TAG_OVERRIDES:
        if keyword in key:
            # A curated profile is authoritative and deliberately skips the
            # "Is ..." flag pass - several workbook rows carry wrong booleans
            # (Dragon Age: Origins is flagged "Is Platformer / Metroidvania",
            # Cities: Skylines is flagged "Is Action") and enriching from them
            # would put the same bad labels back on the titles we curated.
            add(profile)
            return tags

    bucket = str(primary_genre or '').strip().lower()
    if bucket in BUCKET_TAGS:
        add(BUCKET_TAGS[bucket])
    else:
        add(split_genre_string(primary_genre))

    for column, extra in FLAG_TAGS.items():
        if is_yes(row.get(column)):
            add(extra)

    return tags


def populate_genres(conn: sqlite3.Connection, games: pd.DataFrame):
    """Fill AppGenres + AppGameGenreMap from the seeded AppGames rows."""
    conn.execute('DELETE FROM "AppGameGenreMap"')
    conn.execute('DELETE FROM "AppGenres"')

    assignments = []
    for _, row in games.iterrows():
        game_id = coerce_values(row.get('GameID'))
        if game_id is None:
            continue
        tags = derive_genre_tags(row.get('Game Title'), row.get('Primary Genre'), row)
        for tag in tags:
            assignments.append((str(game_id), tag))

    unique_tags = sorted({tag for _, tag in assignments})
    conn.executemany(
        'INSERT OR IGNORE INTO "AppGenres" ("GenreName") VALUES (?)',
        [(tag,) for tag in unique_tags],
    )
    genre_ids = {
        name: gid
        for gid, name in conn.execute('SELECT "GenreID", "GenreName" FROM "AppGenres"')
    }
    conn.executemany(
        'INSERT OR IGNORE INTO "AppGameGenreMap" ("GameID", "GenreID") VALUES (?, ?)',
        [(game_id, genre_ids[tag]) for game_id, tag in assignments],
    )

    untagged = sum(1 for _, row in games.iterrows()
                   if not derive_genre_tags(row.get('Game Title'), row.get('Primary Genre'), row))
    print(f'  Inserted {len(unique_tags)} genres into AppGenres')
    print(f'  Inserted {len(assignments)} rows into AppGameGenreMap')
    if untagged:
        print(f'  WARNING: {untagged} games received no genre tags')


def normalize_header(value) -> str:
    if pd.isna(value):
        return ''
    return str(value).strip().replace('\xa0', ' ').replace('\n', ' ').strip()


def find_header_row(df: pd.DataFrame, expected_columns: Sequence[str]) -> Tuple[int, List[str]]:
    expected_lower = [normalize_header(col).lower() for col in expected_columns]
    id_keywords = {
        'gameid',
        'ownershipid',
        'settingid',
        'frictionid',
        'roadmapid',
        'dlc_id',
        'reviewid',
    }

    candidates = []
    max_search_row = min(6, len(df))
    for idx in range(max_search_row):
        row = df.iloc[idx]
        row_values = [normalize_header(cell).lower() for cell in row.tolist()]
        matches = sum(1 for expected in expected_lower if expected in row_values)
        has_id = any(any(id_key == value for value in row_values) for id_key in id_keywords)
        if has_id or matches > 0:
            candidates.append((idx, matches, row_values))

    if not candidates:
        raise ValueError(f'Header row not found for sheet in first {max_search_row} rows')

    best_index, _, best_row_values = max(candidates, key=lambda candidate: candidate[1])
    headers = [normalize_header(cell) for cell in df.iloc[best_index].tolist()]
    return best_index, headers


def load_sheet(sheet_name: str, expected_columns: Sequence[str]) -> pd.DataFrame:
    df = pd.read_excel(WORKBOOK_PATH, sheet_name=sheet_name, header=None, engine='openpyxl')
    header_idx, headers = find_header_row(df, expected_columns)
    content = df.iloc[header_idx + 1 :].copy()
    content.columns = headers
    valid_columns = [col for col in content.columns if normalize_header(col) and not normalize_header(col).lower().startswith('unnamed')]
    content = content.loc[:, valid_columns]
    content = content.dropna(how='all')
    content = content.reset_index(drop=True)
    content.columns = [normalize_header(col) for col in content.columns]
    return content


def coerce_values(value):
    if pd.isna(value):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value
    if isinstance(value, str):
        return value.strip() or None
    return str(value)


def create_tables(conn: sqlite3.Connection):
    for statement in CREATE_STATEMENTS.values():
        conn.execute(statement)


def insert_records(conn: sqlite3.Connection, table_name: str, data: pd.DataFrame):
    columns = list(data.columns)
    placeholders = ', '.join('?' for _ in columns)
    quoted_columns = ', '.join(f'"{col}"' for col in columns)
    insert_sql = f'INSERT OR REPLACE INTO "{table_name}" ({quoted_columns}) VALUES ({placeholders})'
    rows = []
    for _, row in data.iterrows():
        rows.append([coerce_values(row[col]) for col in columns])
    conn.executemany(insert_sql, rows)


def main():
    if not WORKBOOK_PATH.exists():
        raise FileNotFoundError(f'Workbook not found at {WORKBOOK_PATH}')

    print(f'Loading workbook: {WORKBOOK_PATH}')
    db_exists = OUTPUT_DB.exists()
    if db_exists:
        print(f'Removing existing database at {OUTPUT_DB}')
        OUTPUT_DB.unlink()

    conn = sqlite3.connect(OUTPUT_DB)
    try:
        create_tables(conn)

        games_df = None
        for table_name, definition in TABLE_DEFINITIONS.items():
            sheet_name = definition['sheet_name']
            print(f'Processing sheet: {sheet_name}')
            df = load_sheet(sheet_name, definition['columns'])
            missing = [col for col in definition['columns'] if normalize_header(col).lower() not in [c.lower() for c in df.columns]]
            if missing:
                raise ValueError(f'Missing expected header columns in sheet {sheet_name}: {missing}')
            insert_records(conn, table_name, df)
            print(f'  Inserted {len(df)} rows into {table_name}')
            if table_name == 'AppGames':
                games_df = df

        if games_df is not None:
            print('Normalizing genres into AppGenres / AppGameGenreMap')
            populate_genres(conn, games_df)

        conn.commit()
        print(f'Database seeded successfully at {OUTPUT_DB}')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
