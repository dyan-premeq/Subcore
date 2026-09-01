import type { Database } from 'bun:sqlite'
import type { SqlNamedParams } from '../types'

export interface CsharpInsertRow {
  typeName: string
  filePath: string
  /** dist/assets-relative posix path ('Source/...', 'Mods/<pkg>/...') */
  startLine: number
  modId: number | null
}

export interface CsharpSearchRow {
  typeName: string
  filePath: string
  startLine: number
  modId: number | null
  packageId: string | null
}

export function replaceCsharpIndex(db: Database, rows: CsharpInsertRow[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO csharp_index (typeName, filePath, startLine, modId)
    VALUES ($typeName, $filePath, $startLine, $modId)
  `)

  db.transaction((all: CsharpInsertRow[]) => {
    for (const row of all) {
      insert.run({
        $typeName: row.typeName,
        $filePath: row.filePath,
        $startLine: row.startLine,
        $modId: row.modId,
      })
    }
  })(rows)
}

export function findCsharpTypes(
  db: Database,
  typeName: string,
  filePath?: string,
): CsharpSearchRow[] {
  const clauses = ['c.typeName = $typeName']
  const params: SqlNamedParams = { $typeName: typeName }

  if (filePath !== undefined) {
    clauses.push('c.filePath = $filePath')
    params.$filePath = filePath
  }

  return db
    .query<CsharpSearchRow, SqlNamedParams>(
      `
      SELECT c.typeName, c.filePath, c.startLine, c.modId, m.packageId
      FROM csharp_index c
      LEFT JOIN mods m ON m.modId = c.modId
      WHERE ${clauses.join(' AND ')}
      ORDER BY c.filePath
    `,
    )
    .all(params)
}
