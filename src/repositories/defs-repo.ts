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

export interface DefNameInsertRow {
  name: string
  modId: number
  loadOrder: number
  defType: string
  /** abstract templates have no defName */
  defName: string | null
}

export function replaceDefNames(db: Database, rows: DefNameInsertRow[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO def_names (name, modId, loadOrder, defType, defName)
    VALUES ($name, $modId, $loadOrder, $defType, $defName)
  `)

  db.transaction((all: DefNameInsertRow[]) => {
    for (const row of all) {
      insert.run({
        $name: row.name,
        $modId: row.modId,
        $loadOrder: row.loadOrder,
        $defType: row.defType,
        $defName: row.defName,
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
 * Search across def versions. dup='effective' (default) returns for each
 * (defName, defType) only the row with the highest loadOrder (the mod the game
 * actually uses), with the number of overridden versions; dup='all' returns
 * every mod's version. Portable SQL (no SQLite-specific functions).
 */
export function searchDefsEffective(
  db: Database,
  query: string,
  defType?: string,
  mod?: string,
  limit = 20,
  dup: 'effective' | 'all' = 'effective',
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
  const effectiveFilter =
    dup === 'all'
      ? ''
      : `AND d.loadOrder = (
          SELECT MAX(d3.loadOrder) FROM defs d3
          WHERE d3.defName = d.defName AND d3.defType = d.defType
        )`

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
        ${effectiveFilter}
        ${defType ? ' AND d.defType = $type' : ''}
        ${modFilter}
      ORDER BY d.defName, d.defType, d.loadOrder
      LIMIT $limit
    `,
    )
    .all(params)
}

export interface DefDetailResultRow {
  defType: string
  packageId: string
  loadOrder: number
  filePath: string | null
  payload: string
}

export interface DefDetailOptions {
  view?: 'raw' | 'merged'
  mod?: string
  /** 'effective' = load-order winner only; 'all' = every mod's version */
  dup?: 'effective' | 'all'
}

/**
 * Def detail rows. dup='effective' (default) returns the winner of the
 * load-order override chain per (defName, defType); dup='all' returns one row
 * per defining mod, ordered by load order. `mod` narrows to one packageId.
 */
export function getDefDetailsRows(
  db: Database,
  defName: string,
  defType?: string,
  options: DefDetailOptions = {},
): DefDetailResultRow[] {
  const { view = 'merged', mod, dup = 'effective' } = options
  const payloadColumn = view === 'raw' ? 'rawPayload' : 'mergedPayload'
  const params: SqlNamedParams = { $name: defName }
  let typeFilter = ''
  let modFilter = ''
  if (defType) {
    params.$type = defType
    typeFilter = ' AND d.defType = $type'
  }
  if (mod) {
    params.$mod = mod.toLowerCase()
    modFilter = ' AND m.packageId = $mod'
  }
  const effectiveFilter =
    dup === 'all'
      ? ''
      : `AND d.loadOrder = (
          SELECT MAX(d3.loadOrder) FROM defs d3
          WHERE d3.defName = d.defName AND d3.defType = d.defType
        )`

  return db
    .query<DefDetailResultRow, SqlNamedParams>(
      `
      SELECT d.defType, m.packageId, d.loadOrder, d.filePath,
        d.${payloadColumn} AS payload
      FROM defs d
      JOIN mods m ON m.modId = d.modId
      WHERE d.defName = $name
        ${effectiveFilter}
        ${typeFilter}
        ${modFilter}
      ORDER BY d.defType, d.loadOrder
    `,
    )
    .all(params)
}

export interface DefLineageRow {
  packageId: string
  loadOrder: number
  filePath: string | null
}

/**
 * The full (defName, defType) override chain ordered by load order:
 * first row defines, the last row is what the game actually uses.
 */
export function getDefLineage(
  db: Database,
  defName: string,
  defType?: string,
): DefLineageRow[] {
  const params: SqlNamedParams = { $name: defName }
  let typeFilter = ''
  if (defType) {
    params.$type = defType
    typeFilter = ' AND d.defType = $type'
  }

  return db
    .query<DefLineageRow, SqlNamedParams>(
      `
      SELECT m.packageId, d.loadOrder, d.filePath
      FROM defs d
      JOIN mods m ON m.modId = d.modId
      WHERE d.defName = $name${typeFilter}
      ORDER BY d.loadOrder
    `,
    )
    .all(params)
}
