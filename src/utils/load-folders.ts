import { existsSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { LoadFolderEntry, ModInfo } from '../types'
import {
  compareTuples,
  packageIdNoSuffix,
  parseVersionTuple,
} from './mod-discovery'

const ROOT_FOLDER = '.'
const COMMON_FOLDER = 'Common'
const VERSION_DIR_PATTERN = /^\d+\.\d+$/
const XML_FOLDER_PATHS = ['Defs', 'Patches']

/**
 * Selects the load folders for a mod at the given game version, in descending
 * in-mod priority (first element wins file shadowing). Replicates
 * ModContentPack.InitLoadFolders (1.6.4871):
 *
 * - LoadFolders.xml present with any version key:
 *     1. exact key match (full game version string)
 *     2. highest defined key <= current version (excluding "default")
 *     3. the "default" key
 *   -> only the folders of that key are used (IfModActive/All/NotActive
 *   filtered); Common/root are NOT appended in this branch.
 * - legacy: <root>/<major.minor> if it exists, else the highest 'N.N' folder
 *   <= current version; then <root>/Common if present; then the mod root.
 */
export function selectLoadFolders(
  mod: ModInfo,
  gameVersion: string,
  profilePackages: Set<string>,
): string[] {
  const versionKeys = Object.keys(mod.loadFolders)

  if (versionKeys.length > 0) {
    const key = pickLoadFoldersKey(mod, gameVersion)
    if (key) {
      const entries = mod.loadFolders[key]
        .filter(entry => shouldLoadFolder(entry, profilePackages))
        .map(entry => (entry.folderName === '' ? ROOT_FOLDER : normalizeFolderPath(entry.folderName)))
      // The game iterates the declared list in reverse (AddFolders), so the
      // LAST <li> has the highest priority.
      return entries.reverse()
    }
    // no usable key -> fall through to legacy handling (game behavior)
  }

  const folders: string[] = []
  const withoutBuild = gameVersion.split('.').slice(0, 2).join('.')

  if (existsSync(join(mod.rootPath, withoutBuild))) {
    folders.push(withoutBuild)
  } else {
    const best = mod.versionDirs
      .map(name => ({ name, tuple: parseVersionTuple(name) }))
      .filter((e): e is { name: string; tuple: [number, number, number] } => e.tuple !== undefined)
      .filter(e => compareTuples(e.tuple, parseVersionTuple(gameVersion) ?? [0, 0, 0]) <= 0)
      .sort((a, b) => compareTuples(b.tuple, a.tuple))[0]
    if (best) folders.push(best.name)
  }

  if (existsSync(join(mod.rootPath, COMMON_FOLDER))) {
    folders.push(COMMON_FOLDER)
  }
  folders.push(ROOT_FOLDER)
  return folders
}

function pickLoadFoldersKey(mod: ModInfo, gameVersion: string): string | undefined {
  const keys = Object.keys(mod.loadFolders)

  // 1. exact match on the full version string
  if (mod.loadFolders[gameVersion] !== undefined) return gameVersion

  // 2. highest defined version key <= current ("1.6" < "1.6.4871")
  // NB: the game orders candidate keys by raw string descending (orderby x
  // descending, InitLoadFolders); we sort by version tuple so keys like
  // "1.10" order correctly. Diverges only for multi-digit minor versions —
  // accepted, deterministic.
  const current = parseVersionTuple(gameVersion)
  if (current) {
    const candidates = keys
      .filter(key => key !== 'default' && key !== '')
      .map(key => ({ key, tuple: parseVersionTuple(key) }))
      .filter((e): e is { key: string; tuple: [number, number, number] } => e.tuple !== undefined)
      .filter(e => compareTuples(e.tuple, current) <= 0)
      .sort((a, b) => compareTuples(b.tuple, a.tuple))
    if (candidates.length > 0) return candidates[0].key
  }

  // 3. default
  if (mod.loadFolders['default'] !== undefined) return 'default'

  return undefined
}

/**
 * LoadFolder.ShouldLoad: IfModActive (any of), IfModActiveAll (all of),
 * IfModNotActive (none of) — packageIds matched case-insensitively with
 * "|postfix" stripped on the active side.
 */
export function shouldLoadFolder(entry: LoadFolderEntry, profilePackages: Set<string>): boolean {
  // both sides are matched with "|postfix" stripped (game: ignorePostfix)
  const active = new Set(Array.from(profilePackages, packageIdNoSuffix))
  const isActive = (id: string) => active.has(packageIdNoSuffix(id))

  if (entry.requiredAnyOf && entry.requiredAnyOf.length > 0) {
    if (!entry.requiredAnyOf.some(isActive)) return false
  }
  if (entry.requiredAllOf && entry.requiredAllOf.length > 0) {
    if (!entry.requiredAllOf.every(isActive)) return false
  }
  if (entry.disallowedAnyOf && entry.disallowedAnyOf.length > 0) {
    if (entry.disallowedAnyOf.some(isActive)) return false
  }
  return true
}

function normalizeFolderPath(folder: string): string {
  return folder.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

// #region File shadowing (index-time effective set)

export interface EffectiveFiles {
  /** relative to the mod root; these take part in defs/patches indexing */
  effective: string[]
  /** relative to the mod root; shadowed by a higher-priority load folder */
  shadowed: string[]
}

/**
 * Replicates DirectXmlLoader.XmlAssetsInModFolder: load folders are scanned
 * in descending priority; the first file for a given load-folder-relative key
 * wins (Dictionary.TryAdd). Files whose name starts with "." or "._" are
 * skipped. Scopes: Defs/ and Patches/.
 */
export function computeEffectiveFiles(modRoot: string, foldersDescending: string[]): EffectiveFiles {
  const seen = new Map<string, string>()
  const shadowed: string[] = []

  for (const folder of foldersDescending) {
    const folderDir = folder === ROOT_FOLDER ? modRoot : join(modRoot, folder)
    for (const xmlFolder of XML_FOLDER_PATHS) {
      const scanDir = join(folderDir, xmlFolder)
      if (!existsSync(scanDir)) continue

      for (const absFile of listXmlFiles(scanDir)) {
        const relativeToFolder = toPosix(absFile.slice(folderDir.length + 1))
        const relativeToRoot = folder === ROOT_FOLDER
          ? relativeToFolder
          : toPosix(`${folder}/${relativeToFolder}`)

        // first folder (highest priority) wins per key
        if (!seen.has(relativeToFolder)) {
          seen.set(relativeToFolder, relativeToRoot)
        } else {
          shadowed.push(relativeToRoot)
        }
      }
    }
  }

  return { effective: Array.from(seen.values()), shadowed }
}

function listXmlFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.toLowerCase().endsWith('.xml')) {
        // game skips files starting with "." or "._"
        if (entry.name.startsWith('.')) continue
        out.push(full)
      }
    }
  }
  walk(dir)
  return out.sort()
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

// #endregion
