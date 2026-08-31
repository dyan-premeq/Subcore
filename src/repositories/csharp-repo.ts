import type { Database } from 'bun:sqlite'
import type { CsharpIndexRow, SqlNamedParams } from '../types'

export interface CsharpInsertRow {
  typeName: string
  filePath: string
  startLine: number
}

export function replaceCsharpIndex(db: Database, rows: CsharpInsertRow[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO csharp_index (typeName, filePath, startLine)
    VALUES ($typeName, $filePath, $startLine)
  `)

  db.transaction((all: CsharpInsertRow[]) => {
    for (const row of all) {
      insert.run({
        $typeName: row.typeName,
        $filePath: row.filePath,
        $startLine: row.startLine,
      })
    }
  })(rows)
}

export function findCsharpTypes(db: Database, typeName: string): CsharpIndexRow[] {
  return db
    .query<CsharpIndexRow, SqlNamedParams>(
      'SELECT typeName, filePath, startLine FROM csharp_index WHERE typeName = $typeName ORDER BY filePath',
    )
    .all({ $typeName: typeName })
}
