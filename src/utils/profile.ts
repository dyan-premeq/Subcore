import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Profile } from '../types'
import { modsConfigFromEnv, profilePathFromEnv } from './env'
import {
  PRODUCT_PACKAGE_IDS,
  normalizePackageId,
  parseVersionTuple,
} from './mod-discovery'
import { parser } from './xml-utils'

export const VANILLA_PROFILE_NAME = 'vanilla-only'

/** Behavior when no profile file exists: vanilla Data only, no community mods. */
export function vanillaProfile(): Profile {
  return {
    name: VANILLA_PROFILE_NAME,
    base: 'all-dlc',
    mods: [],
    autoOrder: true,
  }
}

export interface LoadedProfile {
  profile: Profile
  /** false -> vanilla-only defaults were used */
  exists: boolean
  warnings: string[]
}

/** Loads the profile file (env SUBCORE_PROFILE or <repo>/subcore.profile.json). */
export function loadProfile(path = profilePathFromEnv()): LoadedProfile {
  if (!existsSync(path)) {
    return { profile: vanillaProfile(), exists: false, warnings: [] }
  }
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    warnings.push(`failed to parse profile ${path}: ${String(error)}; using vanilla-only`)
    return { profile: vanillaProfile(), exists: true, warnings }
  }
  return { profile: parseProfile(raw, warnings), exists: true, warnings }
}

export function parseProfile(raw: unknown, warnings: string[] = []): Profile {
  if (!raw || typeof raw !== 'object') {
    warnings.push('profile is not an object; using vanilla-only')
    return vanillaProfile()
  }

  const node = raw as Record<string, unknown>
  const base = node.base === 'core-only' ? 'core-only' : 'all-dlc'
  if (node.base !== 'core-only' && node.base !== 'all-dlc') {
    warnings.push(`profile.base "${String(node.base)}" invalid; defaulting to "all-dlc"`)
  }

  const mods = Array.isArray(node.mods)
    ? node.mods.filter((m): m is string => typeof m === 'string').map(normalizePackageId)
    : []
  if (node.mods !== undefined && !Array.isArray(node.mods)) {
    warnings.push('profile.mods must be an array of packageIds; ignoring')
  }

  return {
    name: typeof node.name === 'string' && node.name.trim() !== '' ? node.name : 'unnamed-profile',
    gameVersion: typeof node.gameVersion === 'string' ? node.gameVersion : undefined,
    base,
    mods: dedupe(mods),
    autoOrder: node.autoOrder === false ? false : true,
  }
}

/**
 * Dev-time consistency check: the profile declares which game version it was
 * written for. Warn when it mismatches the actual build version (compared by
 * major.minor — build numbers are irrelevant).
 */
export function checkProfileGameVersion(
  profile: Profile,
  gameVersion: string,
): string | undefined {
  if (!profile.gameVersion) return undefined

  const declared = parseVersionTuple(profile.gameVersion)
  if (!declared) {
    return `profile.gameVersion "${profile.gameVersion}" is not a valid version`
  }
  const actual = parseVersionTuple(gameVersion)
  if (actual && (declared[0] !== actual[0] || declared[1] !== actual[1])) {
    return `profile.gameVersion "${profile.gameVersion}" does not match game version ${gameVersion}`
  }
  return undefined
}

// #region ModsConfig snapshot (--from-game-config)

/**
 * Parses the player's ModsConfig.xml <activeMods> order. This is a snapshot
 * source only — the dev-time load order always comes from the profile.
 */
export function parseModsConfig(xml: string): string[] {
  return activeModsFromXml(xml) ?? []
}

function activeModsFromXml(xml: string): string[] | null {
  let parsed: unknown
  try {
    parsed = parser.parse(xml, true)
  } catch {
    return null
  }
  const root = parsed as Record<string, unknown>
  // game writes <ModsConfigData><activeMods>…; accept <data> too
  const data = (root.data ?? root.ModsConfigData ?? root) as Record<string, unknown>
  const activeMods = data.activeMods as { li?: unknown } | undefined
  if (activeMods === undefined) return null
  const li = activeMods.li
  const items = li === undefined ? [] : Array.isArray(li) ? li : [li]
  return items.map(v => normalizePackageId(String(v))).filter(v => v !== '')
}

/**
 * Snapshots the player's active mod list into a profile draft: original order
 * preserved (autoOrder=false), vanilla base stripped from mods.
 */
export function profileFromModsConfig(activePackageIds: string[], name = 'from-game-config', installedBase?: string[]): Profile {
  const vanilla = new Set<string>(PRODUCT_PACKAGE_IDS)
  const active = activePackageIds.map(normalizePackageId)
  const partialBase = installedBase?.some(id => vanilla.has(id) && !active.includes(id) && id !== PRODUCT_PACKAGE_IDS[0])
  const dlcs = partialBase ? PRODUCT_PACKAGE_IDS.slice(1).filter(id => active.includes(id)) : []
  return {
    name,
    base: partialBase ? 'core-only' : 'all-dlc',
    mods: [...dlcs, ...active.filter(id => !vanilla.has(id))],
    autoOrder: false,
  }
}

/**
 * 1.7 RimWorldWaylith.Bootstrap.ResolvePersistentDataRoot paths for the player's ModsConfig.xml:
 * - Windows: %LOCALAPPDATA%/../LocalLow/Ludeon Studios/RimWorld by Ludeon Studios/Config/ModsConfig.xml
 * - Linux:   $XDG_CONFIG_HOME (default ~/.config), then unity3d/Ludeon Studios/RimWorld by Ludeon Studios/Config/ModsConfig.xml
 * - macOS:   ~/Library/Application Support/RimWorld/Config/ModsConfig.xml
 */
export function discoverModsConfigPath(platform = process.platform): string | undefined {
  const override = modsConfigFromEnv()
  if (override) return override

  const home = homedir()

  let path: string
  switch (platform) {
    case 'win32': {
      const local = process.env.LOCALAPPDATA
      if (!local) return undefined
      path = join(dirname(local), 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config', 'ModsConfig.xml')
      break
    }
    case 'linux': {
      const config = process.env.XDG_CONFIG_HOME || join(home, '.config')
      path = join(config, 'unity3d', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config', 'ModsConfig.xml')
      break
    }
    case 'darwin':
      path = join(home, 'Library', 'Application Support', 'RimWorld', 'Config', 'ModsConfig.xml')
      break
    default:
      return undefined
  }
  return existsSync(path) ? path : undefined
}

export function readPlayerActiveMods(modsConfigPath?: string): string[] | null {
  const path = modsConfigPath ?? discoverModsConfigPath()
  if (!path || !existsSync(path)) return null
  try {
    return activeModsFromXml(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// #endregion

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items))
}
