import type { Database } from 'bun:sqlite'
import type { SqlNamedParams } from '../types'

export interface DefInsertRow {
  defName: string
  defType: string
  modId: number
  loadOrder: number
  label: string | null
  filePath: string | null
  mayRequire: string | null
  rawPayload: string
  mergedPayload: string
}

export function replaceDefs(db: Database, rows: DefInsertRow[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO defs (
      defName, defType, modId, loadOrder, label, filePath, mayRequire,
      rawPayload, mergedPayload
    ) VALUES (
      $defName, $defType, $modId, $loadOrder, $label, $filePath, $mayRequire,
      $rawPayload, $mergedPayload
    )
  `)

  db.transaction((all: DefInsertRow[]) => {
    for (const row of all) {
      insert.run({
        $defName: row.defName,
        $defType: row.defType,
        $modId: row.modId,
        $loadOrder: row.loadOrder,
        $label: row.label,
        $filePath: row.filePath,
        $mayRequire: row.mayRequire,
        $rawPayload: row.rawPayload,
        $mergedPayload: row.mergedPayload,
      })
    }
  })(rows)
}

export interface DefSearchResultRow {
  defName: string
  defType: string
  label: string | null
  packageId: string
  /** how many (defName, defType) rows exist across mods */
  versions: number
  total: number
}

/**
 * Effective-view search: for each (defName, defType) only the row with the
 * highest loadOrder (the mod the game actually uses) is returned, with the
 * number of overridden versions. Portable SQL (no SQLite-specific functions).
 */
export function searchDefsEffective(
  db: Database,
  query: string,
  defType?: string,
  mod?: string,
  limit = 20,
): DefSearchResultRow[] {
  const params: SqlNamedParams = { $q: `%${query}%`, $limit: limit }
  let modFilter = ''
  if (defType) {
    params.$type = defType
  }
  if (mod) {
    params.$mod = mod.toLowerCase()
    modFilter = ' AND m.packageId = $mod'
  }

  return db
    .query<DefSearchResultRow, SqlNamedParams>(
      `
      SELECT d.defName, d.defType, d.label, m.packageId,
        (SELECT COUNT(*) FROM defs d2
          WHERE d2.defName = d.defName AND d2.defType = d.defType) AS versions,
        COUNT(*) OVER () AS total
      FROM defs d
      JOIN mods m ON m.modId = d.modId
      WHERE (d.defName LIKE $q OR d.label LIKE $q)
        AND d.loadOrder = (
          SELECT MAX(d3.loadOrder) FROM defs d3
          WHERE d3.defName = d.defName AND d3.defType = d.defType
        )
        ${defType ? ' AND d.defType = $type' : ''}
        ${modFilter}
      LIMIT $limit
    `,
    )
    .all(params)
}

export interface DefDetailResultRow {
  defType: string
  packageId: string
  payload: string
}

/**
 * Effective-view details: one row per (defName, defType), the winner of the
 * load-order override chain.
 */
export function getDefDetailsEffective(
  db: Database,
  defName: string,
  defType?: string,
  view: 'raw' | 'merged' = 'merged',
): DefDetailResultRow[] {
  const payloadColumn = view === 'raw' ? 'rawPayload' : 'mergedPayload'
  const params: SqlNamedParams = { $name: defName }
  let typeFilter = ''
  if (defType) {
    params.$type = defType
    typeFilter = ' AND d.defType = $type'
  }

  return db
    .query<DefDetailResultRow, SqlNamedParams>(
      `
      SELECT d.defType, m.packageId, d.${payloadColumn} AS payload
      FROM defs d
      JOIN mods m ON m.modId = d.modId
      WHERE d.defName = $name
        AND d.loadOrder = (
          SELECT MAX(d3.loadOrder) FROM defs d3
          WHERE d3.defName = d.defName AND d3.defType = d.defType
        )
        ${typeFilter}
      ORDER BY d.defType
    `,
    )
    .all(params)
}
