import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { ModsManifest } from '../types'
import { indexDbPath, defsPath, versionPath, modsManifestPath } from '../utils/env'
import { ensureSchema, SCHEMA_VERSION } from '../db/schema'
import { replaceMods, type ModInsertRow } from '../repositories/mods-repo'
import { setMeta } from '../repositories/meta-repo'
import { readManifest } from '../utils/manifest'
import {
  PRODUCT_PACKAGE_IDS,
  parseVersionTxt,
} from '../utils/mod-discovery'

/**
 * Builds the mods table:
 * - with a manifest (import-mods ran): manifest mods in load order plus
 *   discovered-but-not-in-profile metadata rows (loadOrder = -1);
 * - without a manifest: vanilla-only synthesis from the dist/assets/Defs
 *   category folders (byte-compatible with pre-mod builds).
 */
export async function rebuildModsIndex(
  dbPath = indexDbPath,
  defsSourcePath = defsPath,
  manifestPath = modsManifestPath,
  distVersionPath = versionPath,
): Promise<void> {
  console.log('Indexing mods...')

  const manifest = readManifest(manifestPath)
  const gameVersion = readGameVersion(manifest, distVersionPath)

  const db = new Database(dbPath)
  try {
    ensureSchema(db)
    db.run('DELETE FROM mods')
    // patched_defs.changedBy holds modIds from the old mods table — drop it
    // rather than serve stale payloads (patched view falls back to merged)
    db.run('DELETE FROM patched_defs')

    if (manifest) {
      insertFromManifest(db, manifest)
    } else {
      // zero-config default for vanilla-only builds: base rows synthesized
      // from the dist/assets/Defs category folders
      synthesizeVanillaBaseMods(db, listCategories(defsSourcePath), gameVersion)
    }

    setMeta(db, 'game_version', gameVersion)
    setMeta(db, 'built_at', new Date().toISOString())

    const count = (
      db.query('SELECT COUNT(*) AS n FROM mods').get() as { n: number }
    ).n
    console.log(`Indexed ${count} mods (schema v${SCHEMA_VERSION}).`)
  } finally {
    db.close()
  }
}

function insertFromManifest(db: Database, manifest: ModsManifest): void {
  const playerActive = new Set(manifest.playerActivePackageIds ?? [])
  const rows = manifest.mods.map(mod => ({
    packageId: mod.packageId,
    name: mod.name,
    author: mod.author ?? null,
    source: mod.source,
    rootPath: mod.rootPath,
    assetPath: mod.assetPath,
    loadOrder: mod.loadOrder,
    inProfile: mod.inProfile,
    playerActive: playerActive.has(mod.packageId),
    activeFolders: mod.activeFolders as string[] | null,
    warnings: [...mod.warnings, ...mod.issues.map(i => `${i.kind}: ${i.detail}`)],
    supportedVersions: mod.supportedVersions,
    dependencies: mod.dependencies,
    dataCategory: mod.dataCategory ?? null,
  }))

  for (const extra of manifest.discoveredNotInProfile) {
    rows.push({
      packageId: extra.packageId,
      name: extra.name,
      author: extra.author ?? null,
      source: extra.source,
      rootPath: extra.rootPath,
      assetPath: '',
      loadOrder: -1,
      inProfile: false,
      playerActive: playerActive.has(extra.packageId),
      activeFolders: [] as string[] | null,
      warnings: extra.warnings,
      supportedVersions: extra.supportedVersions,
      dependencies: extra.dependencies,
      dataCategory: extra.dataCategory ?? null,
    })
  }

  replaceMods(db, rows)
}

function listCategories(defsSourcePath: string): string[] {
  return existsSync(defsSourcePath)
    ? readdirSync(defsSourcePath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    : []
}

/**
 * Vanilla-only builds (no mods manifest): synthesize base mod rows (Core +
 * DLCs) from the dist/assets/Defs category folders so vanilla defs still map
 * to a mod of origin.
 */
function synthesizeVanillaBaseMods(
  db: Database,
  categories: string[],
  gameVersion: string,
): void {
  const rows: ModInsertRow[] = []
  // Core always exists (a defs tree may have no category subfolders at all)
  if (!categories.includes('Core')) {
    rows.push(baseRow('Core'))
  }
  rows.push(...categories.map(baseRow))

  function baseRow(category: string): ModInsertRow {
    const isCore = category === 'Core'
    const packageId = isCore
      ? PRODUCT_PACKAGE_IDS[0]
      : PRODUCT_PACKAGE_IDS.find(id => id.endsWith(`.${category.toLowerCase()}`)) ??
        `ludeon.rimworld.${category.toLowerCase()}`
    return {
      packageId,
      name: isCore ? 'RimWorld Core' : category,
      author: 'Ludeon Studios',
      source: isCore ? 'builtin' : 'dlc',
      rootPath: `Data/${category}`,
      assetPath: '',
      loadOrder: isCore
        ? 0
        : Math.max(1, (PRODUCT_PACKAGE_IDS as readonly string[]).indexOf(packageId)),
      inProfile: true,
      playerActive: false,
      activeFolders: null,
      warnings: [],
      supportedVersions: [gameVersion.split('.').slice(0, 2).join('.')],
      dependencies: [],
      dataCategory: category,
    }
  }

  replaceMods(db, rows)
}

/**
 * Version authority is what the import steps brought in: dist/Version.txt
 * (written by import-defs) or the mods manifest (import-mods).
 * No silent default — fail loudly.
 */
function readGameVersion(manifest: ModsManifest | null, distVersionPath: string): string {
  if (existsSync(distVersionPath)) {
    const parsed = parseVersionTxt(readFileSync(distVersionPath, 'utf8'))
    if (parsed) return parsed
  }
  if (manifest?.gameVersion) return manifest.gameVersion
  throw new Error(
    'Game version unknown: dist/Version.txt is missing or unparseable. ' +
      'Run "bun run import:defs <gameRoot>".',
  )
}

if (import.meta.main) {
  await rebuildModsIndex()
}
