import { Database } from 'bun:sqlite'
import { rm } from 'node:fs/promises'
import { indexDbPath } from '../utils/env'

// Note: dist/mods-manifest.json is intentionally preserved — it is produced
// by import-mods and consumed by index-mods/index-defs/server tools.
try {
  await rm(indexDbPath, { force: true })
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'EBUSY' && code !== 'EPERM') throw error
  // Windows keeps an open file handle when stdio.ts is connected; drop tables in-place.
  const db = new Database(indexDbPath)
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    const objects = db
      .query<{ name: string; type: string }, []>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'source_fts_%'",
      )
      .all()
    for (const { name, type } of objects) {
      db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name.replaceAll('"', '""')}"`)
    }
    db.exec('VACUUM')
  } finally {
    db.close()
  }
}

console.log('Clean complete. Run "bun run build" to rebuild.')
