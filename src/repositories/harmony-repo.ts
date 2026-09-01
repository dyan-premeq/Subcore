import type { Database } from 'bun:sqlite'
import type { SqlNamedParams } from '../types'
import type { HarmonyPatchRecord } from '../utils/harmony-parse'

export interface HarmonyInsertRow extends HarmonyPatchRecord {
  modId: number | null
  filePath: string
}

// Note: flag columns are INTEGER in SQLite — rows carry 0/1 numbers here;
// the tool layer converts to booleans.
export interface HarmonySearchRow {
  modId: number | null
  packageId: string | null
  filePath: string
  patchClass: string | null
  targetType: string | null
  targetMethod: string | null
  prefix: number
  postfix: number
  transpiler: number
  finalizer: number
  total: number
}

export function replaceHarmonyPatches(db: Database, rows: HarmonyInsertRow[]): void {
  const insert = db.prepare(`
    INSERT INTO harmony_patches (
      modId, filePath, patchClass, targetType, targetMethod,
      prefix, postfix, transpiler, finalizer
    ) VALUES (
      $modId, $filePath, $patchClass, $targetType, $targetMethod,
      $prefix, $postfix, $transpiler, $finalizer
    )
  `)

  db.transaction((all: HarmonyInsertRow[]) => {
    for (const row of all) {
      insert.run({
        $modId: row.modId,
        $filePath: row.filePath,
        $patchClass: row.patchClass,
        $targetType: row.targetType,
        $targetMethod: row.targetMethod,
        $prefix: row.prefix ? 1 : 0,
        $postfix: row.postfix ? 1 : 0,
        $transpiler: row.transpiler ? 1 : 0,
        $finalizer: row.finalizer ? 1 : 0,
      })
    }
  })(rows)
}

export function searchHarmonyPatches(
  db: Database,
  filter: { targetType?: string; targetMethod?: string; packageId?: string },
  limit = 50,
): HarmonySearchRow[] {
  const clauses: string[] = []
  const params: SqlNamedParams = { $limit: limit }

  if (filter.targetType) {
    clauses.push('p.targetType = $targetType')
    params.$targetType = filter.targetType
  }
  if (filter.targetMethod) {
    clauses.push('p.targetMethod = $targetMethod')
    params.$targetMethod = filter.targetMethod
  }
  if (filter.packageId) {
    clauses.push('m.packageId = $packageId')
    params.$packageId = filter.packageId.toLowerCase()
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

  return db
    .query<HarmonySearchRow, SqlNamedParams>(
      `
      SELECT p.patchId, p.modId, m.packageId, p.filePath, p.patchClass,
             p.targetType, p.targetMethod,
             p.prefix, p.postfix, p.transpiler, p.finalizer,
             COUNT(*) OVER () AS total
      FROM harmony_patches p
      LEFT JOIN mods m ON m.modId = p.modId
      ${where}
      ORDER BY p.modId, p.filePath, p.patchId
      LIMIT $limit
    `,
    )
    .all(params)
}
