// Single source of truth for index.db DDL (schema v6).
//
// All CREATE TABLE statements live here — scripts and repositories must not
// define tables inline. JSON columns are TEXT parsed in the application
// layer.

import type { Database } from 'bun:sqlite'

export const SCHEMA_VERSION = 6

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS mods (
  modId         INTEGER PRIMARY KEY,
  packageId     TEXT UNIQUE NOT NULL,
  name          TEXT,
  source        TEXT NOT NULL,
  assetPath     TEXT NOT NULL,
  loadOrder     INTEGER NOT NULL,
  inProfile     INTEGER NOT NULL DEFAULT 0,
  activeFolders TEXT,
  warnings      TEXT,
  dataCategory  TEXT
);

CREATE TABLE IF NOT EXISTS defs (
  defName    TEXT NOT NULL,
  defType    TEXT NOT NULL,
  modId      INTEGER NOT NULL REFERENCES mods(modId),
  loadOrder  INTEGER NOT NULL,
  label      TEXT,
  filePath   TEXT,
  mayRequire TEXT,
  rawPayload    JSON,
  mergedPayload JSON,
  PRIMARY KEY (defName, defType, modId)
);

CREATE INDEX IF NOT EXISTS idx_defs_by_name ON defs (defName, defType, loadOrder);

CREATE TABLE IF NOT EXISTS csharp_index (
  typeName  TEXT,
  filePath  TEXT,
  startLine INTEGER,
  modId     INTEGER,          -- owning mods row; NULL = vanilla decompiled root
  PRIMARY KEY (typeName, filePath)
);

-- @Name inheritance registry: one row per (name, mod) registration,
-- mirroring the game's XmlInheritance.nodesByName (a name can be registered
-- by many mods; the resolver rejects same-mod duplicates upstream).

CREATE TABLE IF NOT EXISTS def_names (
  name      TEXT,
  modId     INTEGER,
  loadOrder INTEGER,
  defType   TEXT,
  defName   TEXT,
  PRIMARY KEY (name, modId)
);

-- Tables below belong to later milestones (M3/M4); created up front so the
-- schema is written once and stays stable.

CREATE TABLE IF NOT EXISTS patch_ops (
  patchId   INTEGER PRIMARY KEY,
  modId     INTEGER,
  filePath  TEXT,
  seq       INTEGER,
  opClass   TEXT,
  xpath     TEXT,
  xpathNorm TEXT,
  targetDefs TEXT,
  status    TEXT
);

CREATE TABLE IF NOT EXISTS patched_defs (
  defName   TEXT NOT NULL,
  defType   TEXT NOT NULL,
  payload   JSON,
  changedBy TEXT,
  PRIMARY KEY (defName, defType)
);

CREATE TABLE IF NOT EXISTS harmony_patches (
  patchId      INTEGER PRIMARY KEY,
  modId        INTEGER,
  filePath     TEXT,
  patchClass   TEXT,
  targetType   TEXT,
  targetMethod TEXT,
  prefix       INTEGER,
  postfix      INTEGER,
  transpiler   INTEGER,
  finalizer    INTEGER
);

-- find_refs file-level prefilter: contentless FTS5 over every text file under dist/assets.
-- Token class (alnum + '_') mirrors rg's \b so a per-token AND is a superset of rg hits.
CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
  body, content='', detail=none, columnsize=0,
  tokenize="unicode61 tokenchars '_'"
);
CREATE TABLE IF NOT EXISTS source_files (
  id   INTEGER PRIMARY KEY,   -- = source_fts rowid
  path TEXT UNIQUE NOT NULL   -- posix, relative to dist/assets (same form as csharp_index.filePath)
);
`

export function ensureSchema(db: Database): void {
  db.run(DDL)
  const stored = db
    .prepare<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
    .get(SCHEMA_VERSION_META_KEY)
  // no migration layer by design: a stale db is rebuilt from source, never patched
  if (stored && stored.value !== String(SCHEMA_VERSION)) {
    throw new Error(
      `index.db is schema v${stored.value} but this build expects v${SCHEMA_VERSION} — run "bun run build" to rebuild it.`,
    )
  }
  db
    .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run(SCHEMA_VERSION_META_KEY, String(SCHEMA_VERSION))
}

export const SCHEMA_VERSION_META_KEY = 'schema_version'
