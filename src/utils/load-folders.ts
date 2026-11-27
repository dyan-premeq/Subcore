import { existsSync, readdirSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import type { LoadFolderEntry, ModInfo } from '../types'
import {
  compareTuples,
  packageIdNoSuffix,
  parseVersionTuple,
  parseVersionToken,
} from './mod-discovery'

const ROOT_FOLDER = '.'
const COMMON_FOLDER = 'Common'
const XML_FOLDER_PATHS = ['Defs', 'Patches']

/** 1.7 ModContentPack.InitLoadFolders returns load roots in descending file priority. */
export function selectLoadFolders(
  mod: ModInfo,
  gameVersion: string,
  profilePackages: Set<string>,
): string[] {
  const key = pickLoadFoldersKey(mod, gameVersion)
  if (key) {
    const entries = mod.loadFolders[key]
      .filter(entry => shouldLoadFolder(entry, profilePackages))
      .map(entry => (entry.folderName === '' ? ROOT_FOLDER : normalizeFolderPath(entry.folderName)))
    // The game iterates the declared list in reverse (AddFolders), so the
    // LAST <li> has the highest priority.
    return entries.reverse()
  }

  const folders: string[] = []
  const withoutBuild = gameVersion.split('.').slice(0, 2).join('.')

  if (existsSync(join(mod.rootPath, withoutBuild))) {
    folders.push(withoutBuild)
  } else {
    // 1.7 ModContentPack.InitLoadFolders can pick the first newer version
    // while the selected major is zero. Keep the game's two conditions.
    const current = parseVersionTuple(gameVersion)!
    const versions = mod.versionDirs
      .map(parseVersionToken)
      .filter((v): v is string => v !== undefined)
      .map(v => parseVersionTuple(v)!)
      .sort(compareTuples)
    let selected: [number, number, number] = [0, 0, 0]
    for (const candidate of versions) {
      if ((compareTuples(candidate, selected) > 0 || compareTuples(selected, current) > 0) &&
          (compareTuples(candidate, current) <= 0 || selected[0] === 0)) {
        selected = candidate
      }
    }
    if (selected[0] > 0) folders.push(selected.slice(0, 2).join('.'))
  }

  if (existsSync(join(mod.rootPath, COMMON_FOLDER))) {
    folders.push(COMMON_FOLDER)
  }
  folders.push(ROOT_FOLDER)
  return folders
}

function pickLoadFoldersKey(mod: ModInfo, gameVersion: string): string | undefined {
  const keys = Object.keys(mod.loadFolders)

  // 1.7 ModContentPack.InitLoadFolders tests Count only for the exact-build shortcut.
  if (mod.loadFolders[gameVersion]?.length) return gameVersion

  const current = parseVersionTuple(gameVersion)
  if (current) {
    // The game filters numerically, then orders the original key strings descending.
    const key = keys.sort().reverse().find(key => {
      const version = parseVersionTuple(key)
      return version && compareTuples(version, current) <= 0
    })
    if (key !== undefined) return key
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

export function normalizeFolderPath(folder: string): string {
  return posix.normalize(folder.replaceAll('\\', '/')).replace(/\/+$/, '')
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

/**
 * Assemblies the game actually loads for the selected folders: mirrors
 * ModContentPack.GetAllFilesForMod(mod, "Assemblies/", e => e.ToLower() == ".dll")
 * — recursive, case-insensitive .dll, first-folder-wins per load-folder-relative
 * key. Unlike XML there is no dotfile filter. Root-relative paths.
 */
export function computeEffectiveAssemblies(
  modRoot: string,
  foldersDescending: string[],
): string[] {
  const seen = new Map<string, string>()

  for (const folder of foldersDescending) {
    const folderDir = folder === ROOT_FOLDER ? modRoot : join(modRoot, folder)
    const assembliesDir = join(folderDir, 'Assemblies')
    if (!existsSync(assembliesDir)) continue

    for (const absFile of listDllFiles(assembliesDir)) {
      const relativeToFolder = toPosix(absFile.slice(folderDir.length + 1))
      if (!seen.has(relativeToFolder)) {
        seen.set(relativeToFolder, folder === ROOT_FOLDER
          ? relativeToFolder
          : toPosix(`${folder}/${relativeToFolder}`))
      }
    }
  }

  return Array.from(seen.values())
}

export function listXmlFiles(dir: string, observe?: (path: string) => void): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    observe?.(current)
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

function listDllFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.toLowerCase().endsWith('.dll')) {
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
