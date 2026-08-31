import type { Database } from 'bun:sqlite'
import type { SqlNamedParams } from '../types'

export function getMeta(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, SqlNamedParams>('SELECT value FROM meta WHERE key = $key')
    .get({ $key: key })
  return row?.value ?? null
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
}
