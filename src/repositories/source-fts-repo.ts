import type { Database } from 'bun:sqlite'
import type { SqlNamedParams } from '../types'

/** Files whose token set covers every identifier token of `name` (superset of rg \b hits). */
export function findFilesContaining(db: Database, name: string): string[] {
  const tokens = name.split(/[^A-Za-z0-9_]+/).filter(Boolean)
  const query = tokens.map(token => `"${token}"`).join(' AND ')

  return db
    .query<{ path: string }, SqlNamedParams>(
      `
      SELECT f.path FROM source_fts s JOIN source_files f ON f.id = s.rowid
      WHERE source_fts MATCH $query ORDER BY f.path
    `,
    )
    .all({ $query: query })
    .map(row => row.path)
}
