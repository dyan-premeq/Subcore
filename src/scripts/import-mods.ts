import { argv, write } from 'bun'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LoadOrderIssue,
  ModInfo,
  ModsManifest,
  Profile,
} from '../types'
import {
  gameRootFromEnv,
  modsAssetPath,
  modsConfigFromEnv,
  modsManifestPath,
  workshopRootFromEnv,
} from '../utils/env'
import { discoverMods, escapePackageDirName, parseVersionTxt } from '../utils/mod-discovery'
import {
  checkProfileGameVersion,
  loadProfile,
  profileFromModsConfig,
  readPlayerActiveMods,
} from '../utils/profile'
import { resolveProfileOrder } from '../utils/load-order'
import {
  computeEffectiveAssemblies,
  computeEffectiveFiles,
  selectLoadFolders,
} from '../utils/load-folders'
import { decompileAssemblies, findIlspycmd } from '../utils/decompile'

/** Top-level directories copied into dist; version folders recurse by rule. */
const COPY_DIRS = new Set(['About', 'Defs', 'Patches', 'Source', 'Assemblies', 'Languages'])
const COPY_ROOT_FILES = new Set(['LoadFolders.xml', 'About.xml'])
const VERSION_DIR = /^\d+\.\d+$/
const COMMON_DIR_NAME = 'Common'

export interface ImportModsOptions {
  gameRoot: string
  gameVersion: string
  workshopRoot?: string
  localModsRoot?: string
  profilePath?: string
  modsConfigPath?: string
  distModsPath?: string
  manifestPath?: string
  full?: boolean
}

export interface ImportModsResult {
  manifest: ModsManifest
  copiedFiles: number
  skippedFiles: number
}

/**
 * Discovers mods, resolves the profile load order, copies in-profile mods
 * (full structure, all version folders) into dist/assets/Mods and writes
 * dist/mods-manifest.json with activeFolders + effective file sets.
 */
export async function importMods(options: ImportModsOptions): Promise<ImportModsResult> {
  const {
    gameRoot,
    gameVersion,
    workshopRoot,
    localModsRoot,
    profilePath,
    modsConfigPath,
    distModsPath = modsAssetPath,
    manifestPath = modsManifestPath,
    full = false,
  } = options

  console.log('Discovering mods...')
  const discovered = discoverMods({
    gameRoot,
    workshopRoot: workshopRoot ?? workshopRootFromEnv(),
    localModsRoot,
    gameVersion,
  })
  console.log(`Discovered ${discovered.length} mods.`)

  const loaded = loadProfile(profilePath)
  if (loaded.exists) {
    console.log(`Profile "${loaded.profile.name}" (${loaded.profile.mods.length} mods)`)
  } else {
    console.log('No profile found -> vanilla-only (mods table gets metadata only)')
  }

  const versionWarning = checkProfileGameVersion(loaded.profile, gameVersion)
  if (versionWarning) {
    console.warn(`[profile] ${versionWarning}`)
  }

  const resolved = resolveProfileOrder(discovered, loaded.profile, { gameVersion })
  for (const issue of resolved.issues) {
    console.warn(`[load-order] ${issue.kind}: ${issue.packageId} — ${issue.detail}`)
  }

  const playerActivePackageIds = readPlayerActiveMods(
    modsConfigPath ?? modsConfigFromEnv(),
  )
  if (playerActivePackageIds) {
    console.log(`Player ModsConfig: ${playerActivePackageIds.length} active mods (diagnostic only).`)
  }

  // copy in-profile community mods
  let copiedFiles = 0
  let skippedFiles = 0
  const profilePackages = new Set(resolved.ordered.map(mod => mod.packageId))

  const ilspyCmd = findIlspycmd()
  if (!ilspyCmd) {
    console.warn(
      '[decompile] ilspycmd not found — mod Assemblies will not be decompiled (optional; dotnet tool install -g ilspycmd).',
    )
  }

  const manifestMods = []
  for (let index = 0; index < resolved.ordered.length; index++) {
    const mod = resolved.ordered[index]
    const isCommunity = mod.source === 'local' || mod.source === 'workshop'
    let assetPath = ''
    let effectiveFiles: string[] = []
    let shadowedFiles: string[] = []
    let activeFolders: string[] = []

    if (isCommunity) {
      const dirName = escapePackageDirName(mod.packageId)
      assetPath = `Mods/${dirName}`
      const destRoot = join(distModsPath, dirName)

      const copyStats = copyModTree(mod.rootPath, destRoot, full)
      copiedFiles += copyStats.copied
      skippedFiles += copyStats.skipped

      activeFolders = selectLoadFolders(mod, gameVersion, profilePackages)
      const effective = computeEffectiveFiles(mod.rootPath, activeFolders)
      effectiveFiles = effective.effective
      shadowedFiles = effective.shadowed

      if (ilspyCmd) {
        const assemblies = computeEffectiveAssemblies(mod.rootPath, activeFolders)
        const stats = decompileAssemblies(ilspyCmd, assemblies, destRoot, full)
        if (stats.decompiled + stats.failed > 0) {
          console.log(
            `[decompile] ${mod.packageId}: ${stats.decompiled} assemblies decompiled, ${stats.skipped} skipped, ${stats.failed} failed.`,
          )
        }
      }
    }

    manifestMods.push({
      ...mod,
      loadOrder: index,
      inProfile: true,
      playerActive: playerActivePackageIds?.includes(mod.packageId) ?? false,
      assetPath,
      activeFolders,
      effectiveFiles,
      shadowedFiles,
      issues: resolved.issues.filter(issue => issue.packageId === mod.packageId),
    })
  }

  // metadata for mods outside the profile (visible via list_mods, not indexed)
  const inProfileIds = new Set(manifestMods.map(mod => mod.packageId))
  const discoveredNotInProfile = discovered.filter(mod => !inProfileIds.has(mod.packageId))

  const manifest: ModsManifest = {
    generatedAt: new Date().toISOString(),
    gameVersion,
    profile: loaded.profile,
    playerActivePackageIds,
    mods: manifestMods,
    discoveredNotInProfile,
  }

  await write(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(
    `Import complete: ${copiedFiles} files copied, ${skippedFiles} unchanged (skipped).`,
  )
  console.log(`Manifest: ${manifestPath}`)

  return { manifest, copiedFiles, skippedFiles }
}

// #region Full-structure copy

export interface CopyStats {
  copied: number
  skipped: number
}

/**
 * Copies a mod's structure preserving the original layout (About/Defs/
 * Patches/Source/Assemblies/Languages + all version folders + Common).
 * Heavy asset dirs (Textures, Sounds, ...) are skipped. Incremental: a file
 * is copied only when mtime or size differs from the destination.
 */
export function copyModTree(
  srcRoot: string,
  destRoot: string,
  full = false,
): CopyStats {
  let copied = 0
  let skipped = 0

  // 'root': apply the whitelist (content dirs + version folders);
  // 'all': inside a whitelisted dir everything is copied.
  const walk = (srcDir: string, destDir: string, mode: 'root' | 'all') => {
    mkdirSync(destDir, { recursive: true })

    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const name = entry.name
      if (name.startsWith('.')) continue // junk/hidden files

      const src = join(srcDir, name)
      const dest = join(destDir, name)

      if (entry.isFile()) {
        if (mode === 'all' || COPY_ROOT_FILES.has(name)) {
          if (shouldCopy(src, dest, full)) {
            copyFileSync(src, dest)
            copied += 1
          } else {
            skipped += 1
          }
        } else {
          skipped += 1
        }
        continue
      }

      if (!entry.isDirectory()) continue

      if (mode === 'all') {
        walk(src, dest, 'all')
        continue
      }

      const isContentDir = COPY_DIRS.has(name)
      const isVersionDir = VERSION_DIR.test(name) || name === COMMON_DIR_NAME
      if (isContentDir) {
        walk(src, dest, 'all')
      } else if (isVersionDir) {
        walk(src, dest, 'root')
      } else {
        // heavy assets or unknown dirs are not copied (design doc §5.2)
        skipped += countFiles(src)
      }
    }
  }

  walk(srcRoot, destRoot, 'root')
  return { copied, skipped }
}

function shouldCopy(src: string, dest: string, full: boolean): boolean {
  if (full || !existsSync(dest)) return true
  const a = statSync(src)
  const b = statSync(dest)
  return a.mtimeMs !== b.mtimeMs || a.size !== b.size
}

function countFiles(dir: string): number {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name))
    else if (entry.isFile()) count += 1
  }
  return count
}

// #endregion

// #region --from-game-config snapshot

export async function snapshotProfileFromGameConfig(
  outPath: string,
  modsConfigPath?: string,
): Promise<Profile> {
  const active = readPlayerActiveMods(modsConfigPath)
  if (active === null) {
    console.error(
      'Could not read ModsConfig.xml. Set RIMSAGE_MODS_CONFIG or pass --mods-config <path>.',
    )
    process.exit(1)
  }

  const profile = profileFromModsConfig(active)
  await write(outPath, JSON.stringify(profile, null, 2))
  console.log(
    `Profile snapshot written to ${outPath} (${profile.mods.length} community mods, autoOrder=false).`,
  )
  console.log('Trim the list to the mods you actually need, then re-run import-mods.')
  return profile
}

// #endregion

// #region CLI

function printUsage(): void {
  console.log(`Usage:
  bun src/scripts/import-mods.ts [gameRoot] [options]

Options:
  --from-game-config    snapshot player ModsConfig.xml into a profile draft, then exit
  --out <path>          output path for the profile snapshot
  --profile <path>      profile file to use (default: RIMSAGE_PROFILE or rimsage.profile.json)
  --workshop-root <p>   workshop content root (default: inferred from gameRoot)
  --mods-config <path>  ModsConfig.xml path (default: auto-discovered)
  --full                force full re-copy (ignore incremental mtime/size)
  gameRoot defaults to RIMSAGE_GAME_ROOT.
`)
}

const VALUE_FLAGS = ['--out', '--profile', '--workshop-root', '--mods-config']

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index !== -1 ? args[index + 1] : undefined
}

function positionalArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) continue
    const prev = i > 0 ? args[i - 1] : undefined
    if (prev && VALUE_FLAGS.includes(prev)) continue
    return arg
  }
  return undefined
}

if (import.meta.main) {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  const gameRoot = positionalArg(args) ?? gameRootFromEnv()

  if (!gameRoot || !existsSync(join(gameRoot, 'Version.txt'))) {
    console.error(
      'Game root not found (need a path with Version.txt). Pass it or set RIMSAGE_GAME_ROOT.',
    )
    process.exit(1)
  }

  const gameVersion = parseVersionTxt(
    readFileSync(join(gameRoot, 'Version.txt'), 'utf8'),
  )

  if (!gameVersion) {
    console.error(
      `Could not parse a game version from ${join(gameRoot, 'Version.txt')}.`,
    )
    process.exit(1)
  }

  if (args.includes('--from-game-config')) {
    const out = flagValue(args, '--out') ?? process.env.RIMSAGE_PROFILE
    if (!out) {
      console.error('--from-game-config needs --out <path> or RIMSAGE_PROFILE set.')
      process.exit(1)
    }
    await snapshotProfileFromGameConfig(out, flagValue(args, '--mods-config'))
    process.exit(0)
  }

  await importMods({
    gameRoot,
    gameVersion,
    workshopRoot: flagValue(args, '--workshop-root'),
    modsConfigPath: flagValue(args, '--mods-config'),
    profilePath: flagValue(args, '--profile') ?? process.env.RIMSAGE_PROFILE,
    full: args.includes('--full'),
  })
}
