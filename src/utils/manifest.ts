import { existsSync, readFileSync } from 'node:fs'
import { modsManifestPath } from './env'
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
