import type { Database } from 'bun:sqlite'
import type { SqlNamedParams } from '../types'
import type { PatchOpStatus } from '../utils/patch-evaluator'

// #region patch_ops

export interface PatchOpInsertRow {
  modId: number
  filePath: string
  seq: number
  opClass: string
  xpath: string | null
  xpathNorm: string | null
  targetDefs: string[]
  status: PatchOpStatus
}

export function replacePatchOps(db: Database, rows: PatchOpInsertRow[]): void {
  const insert = db.prepare(`
    INSERT INTO patch_ops (modId, filePath, seq, opClass, xpath, xpathNorm, targetDefs, status)
    VALUES ($modId, $filePath, $seq, $opClass, $xpath, $xpathNorm, $targetDefs, $status)
  `)

  db.transaction((all: PatchOpInsertRow[]) => {
    for (const row of all) {
      insert.run({
        $modId: row.modId,
        $filePath: row.filePath,
        $seq: row.seq,
        $opClass: row.opClass,
        $xpath: row.xpath,
        $xpathNorm: row.xpathNorm,
        $targetDefs: JSON.stringify(row.targetDefs),
        $status: row.status,
      })
    }
  })(rows)
}

export interface PatchOpSearchRow {
  patchId: number
  modId: number
  packageId: string
  filePath: string
  seq: number
  opClass: string
  xpath: string | null
  targetDefs: string
  status: string
  total: number
}

/**
 * Reverse lookup over evaluated patches: which mod's which file and operation
 * touched a def / belongs to a mod / uses an op class. Any filter optional.
 * targetDefs matching is an exact JSON element match ('"defName"' inside the
 * stored JSON array). LIKE metacharacters in defName are ESCAPEd, so '_' in
 * names like Gun_A matches literally (not as a single-char wildcard).
 */
export function searchPatchOps(
  db: Database,
  filter: { defName?: string; packageId?: string; opClass?: string },
  limit = 50,
): PatchOpSearchRow[] {
  const clauses: string[] = []
  const params: SqlNamedParams = { $limit: limit }

  if (filter.defName) {
    clauses.push("p.targetDefs LIKE $target ESCAPE '\\'")
    params.$target = `%"${filter.defName.replace(/[\\%_]/g, '\\$&')}"%`
  }
  if (filter.packageId) {
    clauses.push('m.packageId = $packageId')
    params.$packageId = filter.packageId.toLowerCase()
  }
  if (filter.opClass) {
    clauses.push('p.opClass = $opClass')
    params.$opClass = filter.opClass.toLowerCase()
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

  return db
    .query<PatchOpSearchRow, SqlNamedParams>(
      `
      SELECT p.patchId, p.modId, m.packageId, p.filePath, p.seq, p.opClass,
             p.xpath, p.targetDefs, p.status,
             COUNT(*) OVER () AS total
      FROM patch_ops p
      JOIN mods m ON m.modId = p.modId
      ${where}
      ORDER BY p.modId, p.filePath, p.seq
      LIMIT $limit
    `,
    )
    .all(params)
}

export function countPatchOpsByStatus(db: Database): { status: string; n: number }[] {
  return db
    .query<{ status: string; n: number }, SqlNamedParams>(
      'SELECT status, COUNT(*) AS n FROM patch_ops GROUP BY status ORDER BY n DESC',
    )
    .all({})
}

// #endregion

// #region patched_defs

export interface PatchedDefInsertRow {
  defName: string
  defType: string
  payload: string
  changedBy: number[]
}

export function replacePatchedDefs(db: Database, rows: PatchedDefInsertRow[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO patched_defs (defName, defType, payload, changedBy)
    VALUES ($defName, $defType, $payload, $changedBy)
  `)

  db.transaction((all: PatchedDefInsertRow[]) => {
    for (const row of all) {
      insert.run({
        $defName: row.defName,
        $defType: row.defType,
        $payload: row.payload,
        $changedBy: JSON.stringify(row.changedBy),
      })
    }
  })(rows)
}

export interface PatchedDefRow {
  defName: string
  defType: string
  payload: string
  changedBy: string
}

/** The patch-evaluated defs (post-patch inheritance view), one row per defType. */
export function getPatchedDefs(
  db: Database,
  defName: string,
  defType?: string,
): PatchedDefRow[] {
  const params: SqlNamedParams = { $name: defName }
  let typeFilter = ''
  if (defType) {
    params.$type = defType
    typeFilter = ' AND defType = $type'
  }
  return db
    .query<PatchedDefRow, SqlNamedParams>(
      `SELECT defName, defType, payload, changedBy FROM patched_defs
       WHERE defName = $name${typeFilter}
       ORDER BY defType`,
    )
    .all(params)
}

/** modId → packageId map for translating patched_defs.changedBy. */
export function getPackageIdMap(db: Database): Map<number, string> {
  const rows = db
    .query<{ modId: number; packageId: string }, SqlNamedParams>(
      'SELECT modId, packageId FROM mods',
    )
    .all({})
  return new Map(rows.map(row => [row.modId, row.packageId]))
}

// #endregion
