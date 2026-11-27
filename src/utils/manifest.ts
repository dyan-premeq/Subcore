import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { distPath, modsManifestPath } from './env'
import type { ModsManifest } from '../types'

/**
 * Reads dist/mods-manifest.json (produced by import-mods). Server tools use
 * it for `loaded_only` search filtering; index scripts use it for the mods
 * table. Returns null when mods were never imported (vanilla-only builds);
 * a corrupted manifest throws.
 */
export function readManifest(path = modsManifestPath): ModsManifest | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as ModsManifest
}

// A standalone import can change live files without updating index.db. Its receipt
// remembers the installation and is consumed when sync next publishes a complete index.
export const IMPORT_RECEIPT = 'pending-import-root.txt'

export function markStandaloneImport(dist: string, gameRoot: string): void {
  mkdirSync(dist, { recursive: true })
  const path = join(dist, IMPORT_RECEIPT)
  const tmp = path + '.' + crypto.randomUUID()
  writeFileSync(tmp, resolve(gameRoot))
  renameSync(tmp, path)
}

export function importedGameRoot(dist = distPath, manifest = readManifest(join(dist, 'mods-manifest.json'))): string | undefined {
  const receipt = join(dist, IMPORT_RECEIPT)
  if (existsSync(receipt)) return readFileSync(receipt, 'utf8')
  const core = manifest?.mods.find(mod => mod.source === 'builtin')
  return manifest?.gameRoot ?? (core && dirname(dirname(core.rootPath)))
}
