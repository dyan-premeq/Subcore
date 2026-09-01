import { join } from 'node:path'

export const root = join(import.meta.dir, '../../')
const distPath = join(root, 'dist')

export const versionPath = join(distPath, 'Version.txt')
export const assetsPath = join(distPath, 'assets')
export const defsPath = join(distPath, 'assets/Defs')
export const patchesPath = join(distPath, 'assets/Patches')
export const sourcePath = join(distPath, 'assets/Source')
export const modsAssetPath = join(distPath, 'assets/Mods')
export const indexDbPath = join(distPath, 'index.db')
export const modsManifestPath = join(distPath, 'mods-manifest.json')

// #region Optional mod-support configuration (M1)
// All are environment-overridable; CLI args take precedence over these (see
// import-mods.ts). They are functions (not constants) so tests and callers can
// set process.env at runtime.

export function gameRootFromEnv(): string | undefined {
  return process.env.RIMSAGE_GAME_ROOT
}

export function workshopRootFromEnv(): string | undefined {
  return process.env.RIMSAGE_WORKSHOP_ROOT
}

export function modsConfigFromEnv(): string | undefined {
  return process.env.RIMSAGE_MODS_CONFIG
}

export function profilePathFromEnv(): string {
  return process.env.RIMSAGE_PROFILE ?? join(root, 'rimsage.profile.json')
}
// #endregion
