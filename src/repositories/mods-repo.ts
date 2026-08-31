import type { Database } from 'bun:sqlite'
import type { ModSource, ModsRow, SqlNamedParams } from '../types'

export interface ModInsertRow {
  packageId: string
  name: string | null
  author: string | null
  source: ModSource
  rootPath: string
  assetPath: string
  loadOrder: number
  inProfile: boolean
  playerActive: boolean
  activeFolders: string[] | null
  warnings: string[]
  supportedVersions: string[]
  dependencies: { packageId: string; displayName?: string }[]
  dataCategory: string | null
}

export function replaceMods(db: Database, rows: ModInsertRow[]): void {
  const insert = db.prepare(`
    INSERT INTO mods (
      packageId, name, author, source, rootPath, assetPath, loadOrder,
      inProfile, playerActive, activeFolders, warnings, supportedVersions,
      dependencies, dataCategory
    ) VALUES (
      $packageId, $name, $author, $source, $rootPath, $assetPath, $loadOrder,
      $inProfile, $playerActive, $activeFolders, $warnings, $supportedVersions,
      $dependencies, $dataCategory
    )
  `)

  db.transaction((all: ModInsertRow[]) => {
    for (const row of all) {
      insert.run({
        $packageId: row.packageId,
        $name: row.name,
        $author: row.author,
        $source: row.source,
        $rootPath: row.rootPath,
        $assetPath: row.assetPath,
        $loadOrder: row.loadOrder,
        $inProfile: row.inProfile ? 1 : 0,
        $playerActive: row.playerActive ? 1 : 0,
        $activeFolders: row.activeFolders ? JSON.stringify(row.activeFolders) : null,
        $warnings: JSON.stringify(row.warnings),
        $supportedVersions: JSON.stringify(row.supportedVersions),
        $dependencies: JSON.stringify(row.dependencies),
        $dataCategory: row.dataCategory,
      })
    }
  })(rows)
}

export function listMods(
  db: Database,
  filter: { inProfile?: boolean; playerActive?: boolean } = {},
): ModsRow[] {
  const clauses: string[] = []
  const params: SqlNamedParams = {}

  if (filter.inProfile !== undefined) {
    clauses.push('inProfile = $inProfile')
    params.$inProfile = filter.inProfile ? 1 : 0
  }
  if (filter.playerActive !== undefined) {
    clauses.push('playerActive = $playerActive')
    params.$playerActive = filter.playerActive ? 1 : 0
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  return db
    .query<ModsRow, SqlNamedParams>(
      `SELECT * FROM mods ${where}
       ORDER BY CASE WHEN loadOrder < 0 THEN 1 ELSE 0 END, loadOrder, packageId`,
    )
    .all(params)
}

export function getModByPackageId(db: Database, packageId: string): ModsRow | null {
  return (
    db
      .query<ModsRow, SqlNamedParams>('SELECT * FROM mods WHERE packageId = $packageId')
      .get({ $packageId: packageId.toLowerCase() }) ?? null
  )
}

export function getModByDataCategory(db: Database, category: string): ModsRow | null {
  return (
    db
      .query<ModsRow, SqlNamedParams>('SELECT * FROM mods WHERE dataCategory = $category')
      .get({ $category: category }) ?? null
  )
}

export function countMods(db: Database): number {
  return (db.query('SELECT COUNT(*) AS n FROM mods').get() as { n: number }).n
}

/** packageIds of the current dev profile: the MayRequire evaluation set. */
export function listInProfilePackageIds(db: Database): string[] {
  return db
    .query<{ packageId: string }, SqlNamedParams>(
      'SELECT packageId FROM mods WHERE inProfile = 1',
    )
    .all({})
    .map(row => row.packageId)
}

/**
 * Display names of profile-active mods: the PatchOperationFindMod match set
 * (game: ModLister.HasActiveModWithName — exact, case-sensitive).
 */
export function listInProfileModNames(db: Database): string[] {
  return db
    .query<{ name: string | null }, SqlNamedParams>(
      'SELECT name FROM mods WHERE inProfile = 1 AND name IS NOT NULL',
    )
    .all({})
    .map(row => row.name!)
}
