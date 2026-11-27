import { argv, write } from 'bun'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  ManifestMod,
  ModInfo,
  ModsManifest,
  Profile,
} from '../types'
import {
  gameRootFromEnv,
  modsAssetPath,
  modsManifestPath,
  workshopRootFromEnv,
} from '../utils/env'
import { importedGameRoot, markStandaloneImport } from '../utils/manifest'
import { discoverBaseMods, discoverMods, escapePackageDirName, parseVersionTxt } from '../utils/mod-discovery'
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
  normalizeFolderPath,
  selectLoadFolders,
} from '../utils/load-folders'
import { decompileAssemblies, findIlspycmd } from '../utils/decompile'

/** Content copied at each declared or legacy load root. */
const COPY_DIRS = ['About', 'Defs', 'Patches', 'Source', 'Assemblies', 'Languages']

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
  /** Overrides findIlspycmd(); null simulates a missing ilspycmd (tests). */
  ilspyCmd?: string | null
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
    ilspyCmd = findIlspycmd(),
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

  markStandaloneImport(dirname(manifestPath), gameRoot)
  // copy in-profile community mods
  let copiedFiles = 0
  let skippedFiles = 0
  const profilePackages = new Set(resolved.ordered.map(mod => mod.packageId))

  if (!ilspyCmd) {
    console.warn(
      '[decompile] ilspycmd not found — mod Assemblies will not be decompiled (optional; dotnet tool install -g ilspycmd).',
    )
  }

  const manifestMods = []
  for (let index = 0; index < resolved.ordered.length; index++) {
    const mod = resolved.ordered[index]
    const assets = emptyModAssets()
    if (mod.source === 'local' || mod.source === 'workshop') {
      const dirName = escapePackageDirName(mod.packageId)
      const destRoot = join(distModsPath, dirName)
      const stats = copyModTree(mod, destRoot, full)
      copiedFiles += stats.copied
      skippedFiles += stats.skipped
      assets.assetPath = `Mods/${dirName}`
      assets.activeFolders = selectLoadFolders(mod, gameVersion, profilePackages)
      const effective = computeEffectiveFiles(mod.rootPath, assets.activeFolders)
      assets.effectiveFiles = effective.effective
      assets.shadowedFiles = effective.shadowed
      const assemblies = computeEffectiveAssemblies(mod.rootPath, assets.activeFolders)
      assets.warnings = decompileMod(ilspyCmd, assemblies, destRoot, full, gameRoot)
    }
    manifestMods.push({
      ...mod, ...assets, loadOrder: index, inProfile: true,
      warnings: [...mod.warnings, ...assets.warnings],
      issues: resolved.issues.filter(issue => issue.packageId === mod.packageId),
    })
  }

  if (existsSync(distModsPath)) {
    const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
    const activeDirs = new Set(
      manifestMods
        .filter(mod => mod.assetPath)
        .map(mod => pathKey(mod.assetPath.slice('Mods/'.length))),
    )
    for (const entry of readdirSync(distModsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !activeDirs.has(pathKey(entry.name))) {
        rmSync(join(distModsPath, entry.name), { recursive: true, force: true })
      }
    }
  }

  // metadata for mods outside the profile (visible via list_mods, not indexed)
  const inProfileIds = new Set(manifestMods.map(mod => mod.packageId))
  const discoveredNotInProfile = discovered.filter(mod => !inProfileIds.has(mod.packageId))

  const manifest: ModsManifest = {
    gameRoot: resolve(gameRoot),
    generatedAt: new Date().toISOString(),
    gameVersion,
    profile: loaded.profile,
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

export function emptyModAssets(): Pick<ManifestMod, 'activeFolders' | 'assetPath' | 'effectiveFiles' | 'shadowedFiles' | 'warnings'> {
  return { assetPath: '', activeFolders: [], effectiveFiles: [], shadowedFiles: [], warnings: [] }
}

export function decompileMod(ilspyCmd: string | null, assemblies: string[], destRoot: string, full: boolean, gameRoot: string): string[] {
  const stats = decompileAssemblies(ilspyCmd, assemblies, destRoot, full, gameRoot)
  if (stats.decompiled || stats.failed.length) {
    console.error(`[decompile] ${basename(destRoot)}: ${stats.decompiled} decompiled, ${stats.skipped} unchanged, ${stats.failed.length} failed.`)
  }
  if (!ilspyCmd && assemblies.length) return ['assemblies not decompiled (ilspycmd not installed)']
  return stats.failed.length
    ? [`${stats.failed.length} assembly(ies) failed to decompile: ${stats.failed.join(', ')}`]
    : []
}

// #region Full-structure copy

export interface CopyStats {
  copied: number
  skipped: number
}

const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path

/** The copy and the fingerprint must visit exactly the same source tree. */
export function* modContentTree(mod: ModInfo) {
  const folders = new Set(['.', 'Common', ...mod.versionDirs].map(pathKey))
  for (const entries of Object.values(mod.loadFolders)) {
    for (const entry of entries) {
      if (entry.folderName) folders.add(pathKey(normalizeFolderPath(entry.folderName)))
    }
  }
  const prefixes = new Set<string>()
  for (const folder of folders) {
    const parts = folder.split('/')
    for (let i = 1; i <= parts.length; i++) prefixes.add(parts.slice(0, i).join('/'))
  }

  function* walk(relative: string, destDir: string, all: boolean): Generator<{
    srcDir: string; destDir: string; entries: { name: string; destName: string; directory: boolean }[]
  }> {
    const srcDir = join(mod.rootPath, relative)
    const entries = []
    const children = []
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const name = entry.name
      const child = relative === '.' ? name : relative + '/' + name
      const contentDir = folders.has(pathKey(relative)) && COPY_DIRS.find(dir =>
        dir === 'About' ? name.toLowerCase() === 'about' : pathKey(dir) === pathKey(name))
      const destName = contentDir || name
      const rootFile = relative === '.' && name.toLowerCase() === 'loadfolders.xml'
      if (entry.isDirectory()) {
        if (!all && !contentDir && !prefixes.has(pathKey(child))) continue
      } else if (!entry.isFile() || (!all && !rootFile) ||
                 (name.startsWith('.') && !name.toLowerCase().endsWith('.dll'))) {
        continue
      }

      entries.push({ name, destName, directory: entry.isDirectory() })
      if (entry.isDirectory()) children.push({ child, dir: join(destDir, destName), all: all || Boolean(contentDir) })
    }
    yield { srcDir, destDir, entries }
    for (const c of children) yield* walk(c.child, c.dir, c.all)
  }

  yield* walk('.', '', false)
}

export function copyModTree(mod: ModInfo, destRoot: string, full = false): CopyStats {
  const stats = { copied: 0, skipped: 0 }
  for (const dir of modContentTree(mod)) {
    const destDir = join(destRoot, dir.destDir)
    mkdirSync(destDir, { recursive: true })
    const stale = new Map(readdirSync(destDir, { withFileTypes: true }).map(e => [pathKey(e.name), e]))
    if (!dir.destDir) stale.delete(pathKey('Source-decompiled'))
    for (const { name, destName, directory } of dir.entries) {
      const dest = join(destDir, destName)
      const src = join(dir.srcDir, name)
      const old = stale.get(pathKey(destName))
      stale.delete(pathKey(destName))
      if (old && old.isDirectory() !== directory) {
        rmSync(dest, { recursive: true, force: true })
      } else if (old && old.name !== destName) {
        renameSync(join(destDir, old.name), dest)
      }
      if (directory) continue

      const source = statSync(src)
      const existing = statSync(dest, { throwIfNoEntry: false })
      if (!full && existing?.size === source.size &&
          Math.trunc(existing.mtimeMs) === Math.trunc(source.mtimeMs)) {
        stats.skipped++
        continue
      }
      copyFileSync(src, dest)
      utimesSync(dest, source.atime, source.mtime)
      stats.copied++
    }
    for (const entry of stale.values()) {
      rmSync(join(destDir, entry.name), { recursive: true, force: true })
    }
  }

  return stats
}

// #endregion

// #region --from-game-config snapshot

export async function snapshotProfileFromGameConfig(
  outPath: string,
  modsConfigPath?: string,
  gameRoot?: string,
): Promise<Profile> {
  const active = readPlayerActiveMods(modsConfigPath)
  if (active === null) {
    throw new Error('Could not read ModsConfig.xml. Set RIMSAGE_MODS_CONFIG or pass --mods-config <path>.')
  }

  const installed = gameRoot ? discoverBaseMods({ gameRoot }).map(mod => mod.packageId) : undefined
  const profile = profileFromModsConfig(active, 'from-game-config', installed)
  const json = JSON.stringify(profile, null, 2)
  if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== json) {
    const temp = outPath + '.' + crypto.randomUUID() + '.tmp'
    await write(temp, json)
    renameSync(temp, outPath)
  }
  console.error(
    `Profile snapshot written to ${outPath} (${profile.mods.length} listed packages, autoOrder=false).`,
  )
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
  gameRoot defaults to RIMSAGE_GAME_ROOT or the last imported installation.
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

  const gameRoot = positionalArg(args) ?? gameRootFromEnv() ?? importedGameRoot()

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
    await snapshotProfileFromGameConfig(out, flagValue(args, '--mods-config'), gameRoot)
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
