import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ensureSchema, resetSchema, SCHEMA_VERSION } from '../db/schema'
import { getMeta, setMeta } from '../repositories/meta-repo'
import { snapshotProfileFromGameConfig } from '../scripts/import-mods'
import { importVanillaSource, importVanillaXml } from '../scripts/import-vanilla'
import type { ModsManifest } from '../types'
import { findIlspycmd } from '../utils/decompile'
import { distPath, gameRootFromEnv, profilePathFromEnv, workshopRootFromEnv } from '../utils/env'
import { IMPORT_RECEIPT, importedGameRoot } from '../utils/manifest'
import { resolveProfileOrder } from '../utils/load-order'
import { discoverMods, inferWorkshopRoot, parseVersionTxt } from '../utils/mod-discovery'
import { checkProfileGameVersion, loadProfile } from '../utils/profile'
import { SyncStage } from '../utils/sync-stage'
import type { XmlPredicates } from '../utils/xml-conditions'
import { digest, fingerprintMod, fingerprintVanilla, hashValues } from './fingerprints'
import { refreshIndexes } from './indexes'
import { prepareMods } from './mods'
import type { JournalSnapshot, openJournal } from './ntfs-journal'

export interface SyncOptions {
  gameRoot?: string
  fromGameConfig?: boolean
  full?: boolean
  profilePath?: string
  modsConfigPath?: string
  workshopRoot?: string
  localModsRoot?: string
  distRoot?: string
  ilspyCmd?: string | null
}

export interface SyncResult {
  status: 'up-to-date' | 'synced'
  mode: 'unchanged' | 'incremental' | 'full'
  gameVersion: string
  activeMods: number
  changedMods: string[]
  removedMods: string[]
  xmlRebuilt: boolean
  elapsedMs: number
}

interface SyncState {
  config: string
  snapshot: string
  manifestHash: string
  ilspy: string | null
  vanilla: { xml: string; source: string }
  predicates: XmlPredicates
}

async function lockWriter(db: Database) {
  // The asynchronous wait also lets another MCP request in this process finish its build.
  const deadline = Date.now() + 300_000
  for (;;) {
    try {
      if (db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode !== 'wal') {
        db.run('PRAGMA journal_mode=WAL')
      }
      db.run('BEGIN IMMEDIATE')
      return
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw err
      await Bun.sleep(100)
    }
  }
}

export async function syncProfile(options: SyncOptions = {}): Promise<SyncResult> {
  const start = performance.now()
  const dist = resolve(options.distRoot ?? distPath)
  mkdirSync(dist, { recursive: true })
  const db = new Database(join(dist, 'index.db'))
  const stage = new SyncStage(dist)
  let priorGeneration: string | null = null
  let journal: ReturnType<typeof openJournal>
  try {
    await lockWriter(db)
    const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE name='meta'").get()
    priorGeneration = hasMeta ? getMeta(db, 'sync_generation') : null
    stage.recover(priorGeneration)
    const version = hasMeta ? Number(getMeta(db, 'schema_version')) : 0
    if (version > SCHEMA_VERSION) throw new Error('This index requires a newer Subcore version.')
    if (version !== SCHEMA_VERSION) {
      resetSchema(db)
      ensureSchema(db)
    }
    db.run('PRAGMA defer_foreign_keys=ON')

    const manifestPath = join(dist, 'mods-manifest.json')
    const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : ''
    const prior: ModsManifest | null = manifestText ? JSON.parse(manifestText) : null
    const root = options.gameRoot ?? gameRootFromEnv() ?? importedGameRoot(dist, prior) ?? getMeta(db, 'game_root')
    if (!root) throw new Error('First sync needs a game root. Pass gameRoot or set SUBCORE_GAME_ROOT.')
    const gameRoot = resolve(root)
    const versionText = readFileSync(join(gameRoot, 'Version.txt'), 'utf8')
    const gameVersion = parseVersionTxt(versionText)
    if (!gameVersion) throw new Error('Invalid Version.txt in ' + gameRoot)

    const profilePath = options.profilePath ?? profilePathFromEnv()
    if (options.fromGameConfig) await snapshotProfileFromGameConfig(profilePath, options.modsConfigPath, gameRoot)
    const { profile, warnings } = loadProfile(profilePath)
    for (const warning of warnings) console.warn('[profile] ' + warning)
    const versionWarning = checkProfileGameVersion(profile, gameVersion)
    if (versionWarning) console.warn('[profile] ' + versionWarning)
    const workshop = options.workshopRoot ?? workshopRootFromEnv() ?? inferWorkshopRoot(gameRoot)
    const workshopRoot = workshop && resolve(workshop)
    const localModsRoot = resolve(options.localModsRoot ?? join(gameRoot, 'Mods'))
    const ilspy = options.ilspyCmd === undefined ? findIlspycmd() : options.ilspyCmd
    const config = hashValues([gameRoot, versionText, localModsRoot, workshopRoot, profile, ilspy])
    const state: SyncState | null = JSON.parse(getMeta(db, 'sync_state') ?? 'null')
    const pendingImport = existsSync(join(dist, IMPORT_RECEIPT))
    const full = Boolean(options.full || pendingImport || !state || !prior || digest(manifestText) !== state.manifestHash ||
      prior.gameRoot !== gameRoot || prior.gameVersion !== gameVersion || state.ilspy !== ilspy)
    const result: SyncResult = {
      status: 'up-to-date', mode: 'unchanged', gameVersion, activeMods: prior?.mods.length ?? 0,
      changedMods: [], removedMods: [], xmlRebuilt: false, elapsedMs: 0,
    }
    const finish = (published = false) => {
      db.run('COMMIT')
      if (published) cleanPublishedStage(db, stage)
      result.elapsedMs = Math.round(performance.now() - start)
      return result
    }

    if (process.platform === 'win32') {
      const roots = [gameRoot, join(gameRoot, 'Data'), localModsRoot]
      if (workshopRoot) roots.push(join(workshopRoot, 'content', '294100'))
      try {
        journal = (await import('./ntfs-journal')).openJournal(roots)
      } catch {
        // The portable content scan is authoritative when native access is unavailable.
      }
    }
    const cached: JournalSnapshot | null = !full && journal
      ? JSON.parse(getMeta(db, 'sync_ntfs') ?? 'null') : null
    if (cached) cached.cursor = getMeta(db, 'sync_usn') ?? cached.cursor
    const dirty = cached && journal ? journal.changes(cached) : undefined
    if (cached && journal && dirty?.size === 0 && state?.config === config) {
      if (cached.cursor !== journal.cursor) setMeta(db, 'sync_usn', journal.cursor)
      return finish()
    }

    const inputs = new Map<string, Set<string>>()
    const reuse: Record<string, string[]> = {}
    const observe = (scope: string) => {
      const paths = new Set<string>()
      inputs.set(scope, paths)
      return (path: string) => { if (journal) paths.add(path) }
    }
    const reusable = (scope: string) => {
      if (!dirty || dirty.has(scope) || !cached!.watched[scope]) return false
      reuse[scope] = cached!.watched[scope]
      return true
    }
    const discovered = discoverMods({ gameRoot, gameVersion, localModsRoot, workshopRoot, observe: observe('discovery') })
    const resolved = resolveProfileOrder(discovered, profile, { gameVersion })
    const vanilla = reusable('vanilla') ? state!.vanilla : fingerprintVanilla(gameRoot, discovered, observe('vanilla'))
    const known = new Map(prior?.mods.map(m => [m.packageId, m]))
    const fingerprints = new Map<string, string>()
    for (const mod of resolved.ordered) {
      if (mod.dataCategory) continue
      const scope = 'mod:' + mod.packageId
      const old = known.get(mod.packageId)
      const fingerprint = old?.fingerprint && old.rootPath === mod.rootPath && reusable(scope)
        ? old.fingerprint : fingerprintMod(mod, observe(scope))
      fingerprints.set(mod.packageId, fingerprint)
    }
    const snapshot = hashValues([config, discovered, vanilla, [...fingerprints]])
    setMeta(db, 'sync_ntfs', JSON.stringify(journal?.capture(inputs, reuse) ?? null))
    if (journal) setMeta(db, 'sync_usn', journal.cursor)
    if (!full && state!.snapshot === snapshot) return finish()

    for (const issue of resolved.issues) console.warn('[load-order] ' + issue.packageId + ': ' + issue.detail)
    const { mods, changed, foldersChanged } = prepareMods(resolved, fingerprints, full ? null : prior,
      gameRoot, gameVersion, ilspy, stage)
    const active = new Set(mods.map(m => m.packageId))
    const manifest: ModsManifest = {
      gameRoot, gameVersion, profile, generatedAt: new Date().toISOString(), mods,
      discoveredNotInProfile: discovered.filter(m => !active.has(m.packageId)),
    }
    const assets = join(dist, 'assets')
    const vanillaXml = full || state!.vanilla.xml !== vanilla.xml
    const vanillaSource = full || state!.vanilla.source !== vanilla.source
    if (vanillaXml) {
      stage.next('assets/Patches')
      importVanillaXml(gameRoot, dirname(stage.next('assets/Defs')))
    }
    if (vanillaSource) importVanillaSource(gameRoot, dirname(stage.next('assets/Source')), true, ilspy)
    const nextVersion = stage.next('Version.txt')
    mkdirSync(dirname(nextVersion), { recursive: true })
    writeFileSync(nextVersion, versionText)

    const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
    const modDirs = new Set(mods.map(m => pathKey(m.assetPath)))
    const modsDir = join(assets, 'Mods')
    if (existsSync(modsDir)) {
      for (const name of readdirSync(modsDir)) {
        const prefix = 'Mods/' + name
        if (!modDirs.has(pathKey(prefix))) stage.next('assets/' + prefix) // removal
      }
    }
    const { removedMods, xmlRebuilt, predicates } = await refreshIndexes(db, manifest, prior, {
      full, changed, foldersChanged, vanillaSource, vanillaXml, predicates: state?.predicates,
    }, assets, stage.asset)

    const json = JSON.stringify(manifest, null, 2)
    writeFileSync(stage.next('mods-manifest.json'), json)
    const generation = crypto.randomUUID()
    setMeta(db, 'sync_generation', generation)
    setMeta(db, 'sync_state', JSON.stringify({ config, snapshot, manifestHash: digest(json), ilspy, vanilla, predicates }))
    setMeta(db, 'built_at', manifest.generatedAt)
    setMeta(db, 'game_root', gameRoot)
    setMeta(db, 'game_version', gameVersion)
    if (pendingImport) stage.next(IMPORT_RECEIPT)
    stage.publish(generation)
    Object.assign(result, { status: 'synced', mode: full ? 'full' : 'incremental', activeMods: mods.length,
      changedMods: changed, removedMods, xmlRebuilt })
    return finish(true)
  } catch (error) {
    if (db.inTransaction) {
      try { stage.recover(priorGeneration) } finally { db.run('ROLLBACK') }
    }
    throw error
  } finally {
    journal?.close()
    db.close(true)
  }
}

/** Reacquire the lock before touching the stage. A competing writer performs recovery itself. */
function cleanPublishedStage(db: Database, stage: SyncStage): void {
  try { db.run('BEGIN IMMEDIATE') } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_BUSY') return
    throw error
  }
  try {
    stage.recover(getMeta(db, 'sync_generation'))
  } finally {
    db.run('COMMIT')
  }
}
