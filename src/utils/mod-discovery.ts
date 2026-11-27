import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  LoadFolderEntry,
  ModDependency,
  ModInfo,
  ModSource,
} from '../types'
import { compareStrings } from './compare'
import { XMLParser } from 'fast-xml-parser'
import { XmlDocument, XmlElement } from 'libxml2-wasm'

// Preserve dotted version strings such as 1.10.
const metadataParser = new XMLParser({ parseTagValue: false, ignoreDeclaration: true })

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

export interface DiscoverModsOptions {
  gameRoot: string
  workshopRoot?: string
  localModsRoot?: string
  observe?: (path: string) => void
  /** current game version ("1.6.4871"); enables version warnings when given */
  gameVersion?: string
}

/**
 * Metadata-level scan of every known mod location. Discovery is always
 * exhaustive and cheap (About.xml + LoadFolders.xml only); profile selection
 * happens separately (profile.ts + load-order.ts).
 */
export function discoverMods(opts: DiscoverModsOptions): ModInfo[] {
  const mods = discoverBaseMods(opts)

  // 2. Local mods (<gameRoot>/Mods).
  const localModsRoot = opts.localModsRoot ?? join(opts.gameRoot, 'Mods')
  mods.push(...discoverDirectory(localModsRoot, 'local', opts.gameVersion, opts.observe))

  // 3. Workshop mods.
  const workshopRoot = opts.workshopRoot ?? inferWorkshopRoot(opts.gameRoot)
  if (workshopRoot) {
    const contentRoot = join(workshopRoot, 'content', '294100')
    mods.push(...discoverDirectory(contentRoot, 'workshop', opts.gameVersion, opts.observe))
  }

  return mods
}

export function discoverBaseMods(opts: DiscoverModsOptions): ModInfo[] {
  const mods: ModInfo[] = []

  // 1. Data packages (builtin Core + DLCs), Core first, then Data order.
  const dataDir = join(opts.gameRoot, 'Data')
  if (existsSync(dataDir)) opts.observe?.(dataDir)
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
      opts.gameVersion, opts.observe,
    )
    if (info) {
      info.dataCategory = category
      mods.push(info)
    }
  }

  return mods
}

function discoverDirectory(
  dir: string,
  source: ModSource,
  gameVersion?: string, observe?: (path: string) => void,
): ModInfo[] {
  if (!existsSync(dir)) return []
  observe?.(dir)

  const mods: ModInfo[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()

  for (const name of entries) {
    const info = readModDir(join(dir, name), source, normalizePackageId(name), gameVersion, observe)
    if (info) mods.push(info)
  }
  return mods
}

// 1.7 ModMetaData.Init uses GenFile.ResolveCaseInsensitiveFilePath for metadata.
function resolveMetadataPath(root: string, observe: ((path: string) => void) | undefined, ...names: string[]): string | undefined {
  let path = root
  for (const name of names) {
    const entries = readdirSync(path, { withFileTypes: true })
    const entry = entries.find(e => e.name === name)
      ?? entries.find(e => e.name.toLowerCase() === name.toLowerCase())
    if (!entry || (name === 'About' && !entry.isDirectory())) return undefined
    path = join(path, entry.name)
    observe?.(path)
  }
  return path
}

export function readModDir(
  rootPath: string,
  source: ModSource,
  fallbackPackageId: string,
  gameVersion?: string, observe?: (path: string) => void,
): ModInfo | undefined {
  if (!existsSync(rootPath)) return undefined

  observe?.(rootPath)
  const warnings: string[] = []
  const dirName = basename(rootPath)

  const aboutPath = resolveMetadataPath(rootPath, observe, 'About', 'About.xml')
  let aboutXml: string | undefined
  if (!aboutPath) {
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
    loadFolders: parseLoadFoldersXmlRaw(rootPath, observe),
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

type VersionEntry = { li?: unknown } | ''
type VersionBlock = Record<string, VersionEntry | VersionEntry[]>

interface AboutMetaData {
  packageId?: string
  name?: string
  author?: string
  supportedVersions?: { li?: unknown }
  modDependencies?: { li?: unknown }
  loadAfter?: { li?: unknown }
  loadBefore?: { li?: unknown }
  incompatibleWith?: { li?: unknown }
  modDependenciesByVersion?: VersionBlock
  loadAfterByVersion?: VersionBlock
  loadBeforeByVersion?: VersionBlock
  incompatibleWithByVersion?: VersionBlock
}

function parseAboutXml(xml: string, warnings: string[]): AboutMetaData | undefined {
  try {
    // 1.7 DirectXmlLoader.ItemFromXmlFile reads DocumentElement regardless of its name.
    const parsed = metadataParser.parse(xml)
    const key = Object.keys(parsed).find(key => !key.startsWith('?'))
    return key === undefined ? undefined : parsed[key]
  } catch (error) {
    warnings.push(`failed to parse About.xml: ${String(error)}`)
    return undefined
  }
}

// 1.7 ModMetaData.InitVersionedData and VersionedData<T>.GetItemForVersion.
function applyPerVersionData(
  mod: ModInfo,
  meta: AboutMetaData | undefined,
  gameVersion?: string,
): void {
  if (!meta || !gameVersion) return

  const current = parseVersionTuple(gameVersion)
  if (!current) return

  const version = current.slice(0, 2).join('.')
  const supported = mod.supportedVersions.map(v => parseVersionTuple(v)!)
  const fallback = supported.some(v => v[0] === current[0] && v[1] === current[1])
    ? undefined
    : supported.filter(v => compareTuples(v, current) < 0)
        .sort((a, b) => compareTuples(b, a))[0]?.slice(0, 2).join('.')

  const pick = (block?: VersionBlock) => {
    if (!block) return undefined
    for (const wanted of [version, fallback]) {
      if (!wanted) continue
      const key = Object.keys(block).find(k => normalizeVersionKey(k) === wanted)
      if (key !== undefined) {
        const entry = block[key]
        const first = Array.isArray(entry) ? entry[0] : entry
        return first || {} // An explicit empty block replaces the unversioned list.
      }
    }
    return undefined
  }

  const deps = pick(meta.modDependenciesByVersion)
  if (deps !== undefined) mod.dependencies = parseDependencyList(deps.li)
  const after = pick(meta.loadAfterByVersion)
  if (after !== undefined) mod.loadAfter = parseStringList(after.li)
  const before = pick(meta.loadBeforeByVersion)
  if (before !== undefined) mod.loadBefore = parseStringList(before.li)
  const incompatible = pick(meta.incompatibleWithByVersion)
  if (incompatible !== undefined) mod.incompatibleWith = parseStringList(incompatible.li)
}

// #endregion

// #region LoadFolders.xml parsing (raw)

/**
 * Parses <root>/LoadFolders.xml into normalized per-version folder lists.
 * Keys are lowercased with a leading 'v' stripped ("v1.6" -> "1.6"), matching
 * ModLoadFolders.LoadDataFromXmlCustom.
 */
export function parseLoadFoldersXmlRaw(rootPath: string, observe?: (path: string) => void): ModInfo['loadFolders'] {
  const path = resolveMetadataPath(rootPath, observe, 'LoadFolders.xml')
  if (!path) return {}

  const result: ModInfo['loadFolders'] = Object.create(null)
  try {
    const doc = XmlDocument.fromString(readFileSync(path, 'utf8'))
    try {
      // 1.7 ModLoadFolders.LoadDataFromXmlCustom appends repeated blocks in document order.
      for (let block = doc.root.firstChild; block; block = block.next) {
        if (!(block instanceof XmlElement)) continue
        const key = normalizeVersionKey(block.name)
        if (key === undefined) continue
        const list = result[key] ??= []
        for (let item = block.firstChild; item; item = item.next) {
          if (!(item instanceof XmlElement)) continue
          const text = item.content.replaceAll('\\', '/')
          const entry: LoadFolderEntry = { folderName: text === '/' ? '' : text }
          const any = splitPackageIds(item.attr('IfModActive')?.value)
          const all = splitPackageIds(item.attr('IfModActiveAll')?.value)
          const none = splitPackageIds(item.attr('IfModNotActive')?.value)
          if (any) entry.requiredAnyOf = any
          if (all) entry.requiredAllOf = all
          if (none) entry.disallowedAnyOf = none
          list.push(entry)
        }
      }
    } finally {
      doc.dispose()
    }
  } catch {
    return {}
  }
  return result
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

// 1.7 VersionControl.TryParseVersionString parses only the first two Int32 components.
export function parseVersionToken(text: string): string | undefined {
  const parts = text.split('.').slice(0, 2)
  if (parts.length !== 2) return undefined
  const version = parseVersionTuple(parts.join('.'))
  return version?.slice(0, 2).join('.')
}

function listVersionDirs(rootPath: string): string[] {
  if (!existsSync(rootPath)) return []
  return readdirSync(rootPath, { withFileTypes: true })
    .filter(e => e.isDirectory() && parseVersionToken(e.name) !== undefined)
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
    if (!/^[+-]?\d+$/.test(part.trim())) return undefined
    const value = Number(part)
    if (value < 0 || value > 2147483647) return undefined
    nums.push(value)
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
