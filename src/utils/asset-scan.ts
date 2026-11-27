import { existsSync } from 'node:fs'
import { Glob } from 'bun'
import type { Database } from 'bun:sqlite'
import { join, sep } from 'node:path'
import type { ModsManifest } from '../types'
import { getModByDataCategory, getModByPackageId } from '../repositories/mods-repo'

/**
 * A file taking part in defs/patch indexing: absolute path to read plus the
 * dist/assets-relative path and the owning mod's identity.
 */
export interface AssetFileRef {
  /** absolute path to read */
  absPath: string
  /** dist/assets-relative path (aligns with rg output) */
  filePath: string
  modId: number
  loadOrder: number
}

/** Matches 'Defs/...' / 'Defs' paths relative to a mod root. */
const DEFS_RE = /(^|\/)Defs(\/|$)/
/** Matches 'Patches/...' / 'Patches' paths relative to a mod root. */
const PATCHES_RE = /(^|\/)Patches(\/|$)/

/**
 * Scans dist/assets/<kind>/<category>/** (vanilla Core + DLC layout produced
 * by import:vanilla). `kind` is 'Defs' or 'Patches'; the top folder under it
 * names the vanilla data category.
 */
export async function scanVanillaFiles(
  db: Database,
  sourcePath: string,
  kind: 'Defs' | 'Patches',
): Promise<AssetFileRef[]> {
  if (!existsSync(sourcePath)) return []

  const glob = new Glob('**/*.xml')
  const out: AssetFileRef[] = []

  for await (const relativePath of glob.scan({ cwd: sourcePath })) {
    const parts = relativePath.split(sep)
    if (parts.length < 2) {
      // import:vanilla always writes <kind>/<category>/... — a root-level
      // file here means a corrupted dist layout
      console.warn(`Skipping ${relativePath}: no category folder (run import:vanilla).`)
      continue
    }
    const category = parts[0]
    const mod = getModByDataCategory(db, category)
    if (!mod) {
      console.warn(`No mod row for vanilla category "${category}"; skipping ${relativePath}`)
      continue
    }
    if (!mod.inProfile) continue
    out.push({
      absPath: join(sourcePath, relativePath),
      filePath: toPosix(relativePath),
      modId: mod.modId,
      loadOrder: mod.loadOrder,
    })
  }

  console.error(`Vanilla ${kind} files: ${out.length}`)
  return out
}

/**
 * Scans dist/assets/Mods/<dir>/<effective files> filtered to the given
 * content kind. The manifest's effective file set is the single source of
 * truth for what the game actually loads (version-folder / LoadFolders
 * shadowing was already resolved by import-mods).
 */
export function scanModFiles(
  db: Database,
  modsSourcePath: string,
  manifest: ModsManifest | null,
  kind: 'Defs' | 'Patches',
  modRoot = (assetPath: string) => join(modsSourcePath, assetPath.slice('Mods/'.length)),
): AssetFileRef[] {
  const out: AssetFileRef[] = []
  const kindRe = kind === 'Defs' ? DEFS_RE : PATCHES_RE
  for (const manifestMod of manifest?.mods ?? []) {
    if (!manifestMod.assetPath) continue
    const root = modRoot(manifestMod.assetPath)
    if (!existsSync(root)) continue
    const modRow = getModByPackageId(db, manifestMod.packageId)
    if (!modRow) {
      console.warn(
        `No mod row for "${manifestMod.packageId}" (run index-mods first); skipping.`,
      )
      continue
    }

    // effectiveFiles order replicates DirectXmlLoader.XmlAssetsInModFolder:
    // load folders in descending priority, files sorted within each folder
    // (Dictionary.TryAdd — first wins). The game consumes patches in exactly
    // this order, so the array order must be preserved here.
    for (const rel of manifestMod.effectiveFiles) {
      const posix = toPosix(rel)
      if (!kindRe.test(posix)) continue
      out.push({
        absPath: join(root, rel),
        filePath: `${manifestMod.assetPath}/${posix}`,
        modId: modRow.modId,
        loadOrder: modRow.loadOrder,
      })
    }
  }

  console.error(`Mod ${kind} files: ${out.length}`)
  return out
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}
