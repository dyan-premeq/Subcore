import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  LoadFolderEntry,
  ModDependency,
  ModInfo,
  ModSource,
} from '../types'
import { compareStrings } from './compare'
import { parser } from './xml-utils'

// Official package ids in ProductPackageIDs order (ModContentPack.cs:50-62).
export const PRODUCT_PACKAGE_IDS = [
  'ludeon.rimworld',
  'ludeon.rimworld.royalty',
  'ludeon.rimworld.ideology',
  'ludeon.rimworld.biotech',
  'ludeon.rimworld.anomaly',
  'ludeon.rimworld.odyssey',
] as const

/** Official Core package id (first of ProductPackageIDs, ModContentPack.cs:50-62). */
export const CORE_PACKAGE_ID = PRODUCT_PACKAGE_IDS[0]

/** Fallback mapping Data/<folder> -> packageId when About.xml is unreadable. */
const DATA_CATEGORY_PACKAGE_IDS: Record<string, string> = {
  Core: CORE_PACKAGE_ID,
  Royalty: 'ludeon.rimworld.royalty',
  Ideology: 'ludeon.rimworld.ideology',
  Biotech: 'ludeon.rimworld.biotech',
  Anomaly: 'ludeon.rimworld.anomaly',
  Odyssey: 'ludeon.rimworld.odyssey',
}

const VERSION_DIR_PATTERN = /^\d+\.\d+$/

export interface DiscoverModsOptions {
  gameRoot: string
  workshopRoot?: string
  localModsRoot?: string
  /** current game version ("1.6.4871"); enables version warnings when given */
  gameVersion?: string
}

/**
 * Metadata-level scan of every known mod location. Discovery is always
 * exhaustive and cheap (About.xml + LoadFolders.xml only); profile selection
 * happens separately (profile.ts + load-order.ts).
 */
export function discoverMods(opts: DiscoverModsOptions): ModInfo[] {
  const mods: ModInfo[] = []

  // 1. Data packages (builtin Core + DLCs), Core first, then Data order.
  const dataDir = join(opts.gameRoot, 'Data')
  const categories = existsSync(dataDir)
    ? readdirSync(dataDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort((a, b) => (a === 'Core' ? -1 : b === 'Core' ? 1 : compareStrings(a, b)))
    : []

  for (const category of categories) {
    const rootPath = join(dataDir, category)
    const fallbackPackageId =
      DATA_CATEGORY_PACKAGE_IDS[category] ?? `ludeon.rimworld.${category.toLowerCase()}`
    const info = readModDir(
      rootPath,
      category === 'Core' ? 'builtin' : 'dlc',
      fallbackPackageId,
      opts.gameVersion,
    )
    if (info) {
      info.dataCategory = category
      mods.push(info)
    }
  }

  // 2. Local mods (<gameRoot>/Mods).
  const localModsRoot = opts.localModsRoot ?? join(opts.gameRoot, 'Mods')
  mods.push(...discoverDirectory(localModsRoot, 'local', opts.gameVersion))

  // 3. Workshop mods.
  const workshopRoot = opts.workshopRoot ?? inferWorkshopRoot(opts.gameRoot)
  if (workshopRoot) {
    const contentRoot = join(workshopRoot, 'content', '294100')
    mods.push(...discoverDirectory(contentRoot, 'workshop', opts.gameVersion))
  }

  return mods
}

function discoverDirectory(
  dir: string,
  source: ModSource,
  gameVersion?: string,
): ModInfo[] {
  if (!existsSync(dir)) return []

  const mods: ModInfo[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()

  for (const name of entries) {
    const info = readModDir(join(dir, name), source, normalizePackageId(name), gameVersion)
    if (info) mods.push(info)
  }
  return mods
}

/**
 * Reads one mod directory: About/About.xml (fallback legacy About.xml at the
 * root), LoadFolders.xml at the mod root, legacy version folders.
 */
export function readModDir(
  rootPath: string,
  source: ModSource,
  fallbackPackageId: string,
  gameVersion?: string,
): ModInfo | undefined {
  if (!existsSync(rootPath)) return undefined

  const warnings: string[] = []
  const dirName = basename(rootPath)

  const aboutAbout = join(rootPath, 'About', 'About.xml')
  const legacyAbout = join(rootPath, 'About.xml')
  let aboutXml: string | undefined
  let aboutPath: string | undefined

  if (existsSync(aboutAbout)) {
    aboutPath = aboutAbout
  } else if (existsSync(legacyAbout)) {
    // Pre-1.3 layout: About.xml at the mod root.
    warnings.push('old-format About.xml at mod root (expected About/About.xml)')
    aboutPath = legacyAbout
  } else {
    warnings.push('missing About.xml; using directory name as packageId')
  }

  if (aboutPath) {
    try {
      aboutXml = readFileSync(aboutPath, 'utf8')
    } catch {
      warnings.push(`failed to read ${aboutPath}`)
    }
  }

  const meta = aboutXml ? parseAboutXml(aboutXml, warnings) : undefined

  const packageId = normalizePackageId(meta?.packageId ?? '') || fallbackPackageId
  if (!meta?.packageId) {
    warnings.push('missing packageId in About.xml; using directory name as packageId')
  }

  const supportedVersions = parseStringList(meta?.supportedVersions?.li)
    .map(parseVersionToken)
    .filter((v): v is string => v !== undefined)

  const mod: ModInfo = {
    packageId,
    name: xmlText(meta?.name) || dirName,
    author: xmlText(meta?.author) || undefined,
    source,
    rootPath,
    supportedVersions,
    loadFolders: parseLoadFoldersXmlRaw(rootPath),
    versionDirs: listVersionDirs(rootPath),
    dependencies: parseDependencyList(meta?.modDependencies?.li),
    loadAfter: parseStringList(meta?.loadAfter?.li),
    loadBefore: parseStringList(meta?.loadBefore?.li),
    incompatibleWith: parseStringList(meta?.incompatibleWith?.li),
    warnings,
    dataCategory: undefined,
  }

  applyPerVersionData(mod, meta, gameVersion)

  if (gameVersion && supportedVersions.length > 0) {
    const current = gameVersion.split('.').slice(0, 2).join('.')
    if (!supportedVersions.includes(current)) {
      mod.warnings.push(`unsupportedVersion: ${current} not in supportedVersions`)
    }
  }

  return mod
}

// #region About.xml parsing

interface AboutMetaData {
  packageId?: string
  name?: string
  author?: string
  supportedVersions?: { li?: unknown }
  modDependencies?: { li?: unknown }
  loadAfter?: { li?: unknown }
  loadBefore?: { li?: unknown }
  incompatibleWith?: { li?: unknown }
  modDependenciesByVersion?: Record<string, { li?: unknown }>
  loadAfterByVersion?: Record<string, { li?: unknown }>
  loadBeforeByVersion?: Record<string, { li?: unknown }>
  incompatibleWithByVersion?: Record<string, { li?: unknown }>
}

function parseAboutXml(xml: string, warnings: string[]): AboutMetaData | undefined {
  try {
    const parsed = parser.parse(xml) as { ModMetaData?: AboutMetaData }
    return parsed.ModMetaData
  } catch (error) {
    warnings.push(`failed to parse About.xml: ${String(error)}`)
    return undefined
  }
}

/**
 * Merges <modDependenciesByVersion> style blocks into the effective lists:
 * the highest version key <= gameVersion wins (replaces the unversioned
 * lists), matching the game's per-version semantics (ModMetaData.Init).
 */
function applyPerVersionData(
  mod: ModInfo,
  meta: AboutMetaData | undefined,
  gameVersion?: string,
): void {
  if (!meta || !gameVersion) return

  const current = parseVersionTuple(gameVersion)
  if (!current) return

  const pick = (byVersion?: Record<string, { li?: unknown }>): unknown => {
    if (!byVersion) return undefined
    // map raw keys ("v1.6") to normalized version tuples, keep <= current
    const candidates = Object.keys(byVersion)
      .map(raw => {
        const key = normalizeVersionKey(raw)
        const tuple = key === undefined ? undefined : parseVersionTuple(key)
        return tuple ? { raw, tuple } : undefined
      })
      .filter((e): e is { raw: string; tuple: [number, number, number] } => e !== undefined)
      .filter(e => compareTuples(e.tuple, current) <= 0)
      .sort((a, b) => compareTuples(b.tuple, a.tuple))
    return candidates.length > 0 ? byVersion[candidates[0].raw] : undefined
  }

  const deps = pick(meta.modDependenciesByVersion)
  if (deps) mod.dependencies = parseDependencyList((deps as { li?: unknown }).li)
  const after = pick(meta.loadAfterByVersion)
  if (after) mod.loadAfter = parseStringList((after as { li?: unknown }).li)
  const before = pick(meta.loadBeforeByVersion)
  if (before) mod.loadBefore = parseStringList((before as { li?: unknown }).li)
  const incompatible = pick(meta.incompatibleWithByVersion)
  if (incompatible) mod.incompatibleWith = parseStringList((incompatible as { li?: unknown }).li)
}

// #endregion

// #region LoadFolders.xml parsing (raw)

/**
 * Parses <root>/LoadFolders.xml into normalized per-version folder lists.
 * Keys are lowercased with a leading 'v' stripped ("v1.6" -> "1.6"), matching
 * ModLoadFolders.LoadDataFromXmlCustom.
 */
export function parseLoadFoldersXmlRaw(rootPath: string): ModInfo['loadFolders'] {
  const path = join(rootPath, 'LoadFolders.xml')
  if (!existsSync(path)) return {}

  let parsed: Record<string, unknown>
  try {
    parsed = parser.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }

  const root = parsed.LoadFolders
  if (!root || typeof root !== 'object') return {}

  const result: ModInfo['loadFolders'] = {}
  for (const [rawKey, value] of Object.entries(root as Record<string, unknown>)) {
    const key = normalizeVersionKey(rawKey)
    if (key === undefined) continue
    if (!value || typeof value !== 'object') continue

    const listNode = (value as Record<string, unknown>).li
    const items = listNode === undefined ? [] : Array.isArray(listNode) ? listNode : [listNode]
    result[key] = items
      .map(item => parseLoadFolderEntry(item))
      .filter((e): e is LoadFolderEntry => e !== undefined)
  }
  return result
}

function parseLoadFolderEntry(item: unknown): LoadFolderEntry | undefined {
  if (item === null || item === undefined) return undefined

  const text =
    typeof item === 'object'
      ? String((item as Record<string, unknown>)['#text'] ?? '').trim()
      : String(item).trim()

  // "/" or "\\" means the mod root itself.
  const folderName =
    text === '/' || text === '\\' ? '' : text.replaceAll('\\', '/')

  const entry: LoadFolderEntry = { folderName }
  if (typeof item === 'object') {
    const attrs = item as Record<string, unknown>
    const anyOf = splitPackageIds(attrs['@_IfModActive'])
    const allOf = splitPackageIds(attrs['@_IfModActiveAll'])
    const notAnyOf = splitPackageIds(attrs['@_IfModNotActive'])
    if (anyOf) entry.requiredAnyOf = anyOf
    if (allOf) entry.requiredAllOf = allOf
    if (notAnyOf) entry.disallowedAnyOf = notAnyOf
  }
  return entry
}

function splitPackageIds(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
}

// #endregion

// #region Small helpers

export function normalizePackageId(id: string): string {
  return id.trim().toLowerCase()
}

/** Lowercase + strip "|postfix" (the game's ignorePostfix matching). */
export function packageIdNoSuffix(id: string): string {
  return normalizePackageId(id).split('|')[0]
}

/**
 * Coerces an XML node to display text. Handles <authors><li>A</li><li>B</li>
 * lists (the game joins them for display) and attribute-less scalars.
 */
function xmlText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(xmlText).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    const node = value as Record<string, unknown>
    if ('#text' in node) return xmlText(node['#text'])
    if ('li' in node) return xmlText(node.li)
  }
  return ''
}

function parseStringList(li: unknown): string[] {
  if (li === undefined || li === null) return []
  const items = Array.isArray(li) ? li : [li]
  return items.map(v => String(v).trim()).filter(v => v !== '')
}

function parseDependencyList(li: unknown): ModDependency[] {
  if (li === undefined || li === null) return []
  const items = Array.isArray(li) ? li : [li]
  return items.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const node = item as Record<string, unknown>
    const packageId = typeof node.packageId === 'string' ? node.packageId.trim() : ''
    if (packageId === '') return []
    const dep: ModDependency = { packageId: normalizePackageId(packageId) }
    if (typeof node.displayName === 'string' && node.displayName.trim() !== '') {
      dep.displayName = node.displayName.trim()
    }
    return [dep]
  })
}

function parseVersionToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^\d+\.\d+$/.test(trimmed)) return undefined
  return trimmed
}

function listVersionDirs(rootPath: string): string[] {
  if (!existsSync(rootPath)) return []
  return readdirSync(rootPath, { withFileTypes: true })
    .filter(e => e.isDirectory() && VERSION_DIR_PATTERN.test(e.name))
    .map(e => e.name)
}

/** "v1.6" -> "1.6"; returns undefined for keys that cannot be version keys. */
export function normalizeVersionKey(key: string): string | undefined {
  const lower = key.toLowerCase()
  const stripped = lower.startsWith('v') ? lower.slice(1) : lower
  return stripped === '' ? undefined : stripped
}

/** Parses "1.6" / "1.6.4871" into a comparable tuple, or undefined. */
export function parseVersionTuple(version: string): [number, number, number] | undefined {
  const parts = version.trim().split('.')
  if (parts.length < 2 || parts.length > 3) return undefined
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    nums.push(Number(part))
  }
  return [nums[0], nums[1], nums[2] ?? 0]
}

/**
 * Extracts the version token from Version.txt content ("1.6.4871 rev590" ->
 * "1.6.4871"). Returns undefined when no version token is found.
 */
export function parseVersionTxt(text: string): string | undefined {
  return /^\s*v?(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1]
}

export function compareTuples(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

// #endregion

/** Escapes a packageId for use as a dist directory name. */
export function escapePackageDirName(packageId: string): string {
  return packageId.toLowerCase().replace(/[^a-z0-9.]/g, '_')
}

// #region Workshop root inference

/**
 * Steam default layout: game lives at <steam>/steamapps/common/RimWorld ->
 * workshop content at <steam>/steamapps/workshop. Anything else: set
 * RIMSAGE_WORKSHOP_ROOT.
 */
export function inferWorkshopRoot(gameRoot: string): string | undefined {
  const candidate = join(gameRoot, '../../workshop')
  return existsSync(candidate) ? candidate : undefined
}

// #endregion
