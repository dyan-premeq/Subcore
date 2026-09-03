import type { Database } from 'bun:sqlite'
import type { SqlNamedParams } from '../types'

/** Vocab expansion cap: beyond this the MATCH expression gets unwieldy, caller falls back to rg. */
export const MAX_EXPANDED_TERMS = 5000

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

/**
 * Files containing `fragment` as a substring of any token — a superset of rg's
 * substring hits because fragment chars all fall inside the token class.
 * Returns null when the fragment expands to more than MAX_EXPANDED_TERMS terms.
 */
export function findFilesContainingFragment(
  db: Database,
  fragment: string,
): string[] | null {
  // vocab table lives in temp for the connection's lifetime; IF NOT EXISTS is
  // idempotent and fts5vocab reads the live term index, so re-indexing needs
  // no recreation
  db.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS temp.source_fts_vocab USING fts5vocab(main, 'source_fts', 'row')`,
  )

  // LIKE's `_` wildcard only widens the superset; the caller's per-line regex
  // filters exactly, so the fragment is not escaped
  const terms = db
    .query<{ term: string }, SqlNamedParams>(
      'SELECT term FROM temp.source_fts_vocab WHERE term LIKE $pattern',
    )
    .all({ $pattern: `%${fragment.toLowerCase()}%` })
    .map(row => row.term)

  if (terms.length > MAX_EXPANDED_TERMS) return null
  if (terms.length === 0) return []

  const query = terms.map(term => `"${term}"`).join(' OR ')

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
