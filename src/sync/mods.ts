import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { copyModTree, decompileMod, emptyModAssets } from '../scripts/import-mods'
import type { ManifestMod, ModsManifest, ResolvedLoadOrder } from '../types'
import { computeEffectiveAssemblies, computeEffectiveFiles, selectLoadFolders } from '../utils/load-folders'
import { escapePackageDirName } from '../utils/mod-discovery'
import type { SyncStage } from '../utils/sync-stage'
import { digest, fingerprintMod } from './fingerprints'

export function prepareMods(
  resolved: ResolvedLoadOrder, fingerprints: Map<string, string>,
  previous: ModsManifest | null, gameRoot: string, gameVersion: string, ilspy: string | null,
  stage: SyncStage,
) {
  const active = new Set(resolved.ordered.map(m => m.packageId))
  const before = new Map(previous?.mods.map(m => [m.packageId, m]))
  const changed: string[] = []
  let foldersChanged = false
  const paths = new Set<string>()
  const mods = resolved.ordered.map((mod, loadOrder): ManifestMod => {
    const next: ManifestMod = {
      ...mod, ...emptyModAssets(), warnings: mod.warnings, loadOrder, inProfile: true,
      issues: resolved.issues.filter(i => i.packageId === mod.packageId),
    }
    const content = fingerprints.get(mod.packageId)
    if (!content) return next
    const dirName = escapePackageDirName(mod.packageId)
    if (!dirName || dirName === '.' || dirName === '..' || paths.has(dirName)) {
      throw new Error('Ambiguous asset directory for ' + mod.packageId)
    }
    paths.add(dirName)
    next.assetPath = 'Mods/' + dirName
    next.fingerprint = content
    next.activeFolders = selectLoadFolders(mod, gameVersion, active)
    const old = before.get(mod.packageId)
    const sameFolders = old && JSON.stringify(old.activeFolders) === JSON.stringify(next.activeFolders)
    if (old && !sameFolders) foldersChanged = true
    const live = stage.asset(next.assetPath)
    if (sameFolders && old.fingerprint === next.fingerprint && existsSync(live)) {
      next.effectiveFiles = old.effectiveFiles
      next.shadowedFiles = old.shadowedFiles
      next.assemblyHashes = old.assemblyHashes
      next.decompileWarnings = old.decompileWarnings
    } else {
      const dest = stage.next('assets/' + next.assetPath)
      copyModTree(mod, dest, true)
      if (fingerprintMod({ ...mod, rootPath: dest }, () => {}) !== content) {
        throw new Error('Mod content changed during import: ' + mod.packageId + '. Retry sync.')
      }
      const files = computeEffectiveFiles(dest, next.activeFolders)
      next.effectiveFiles = files.effective
      next.shadowedFiles = files.shadowed
      const assemblies = computeEffectiveAssemblies(dest, next.activeFolders)
      next.assemblyHashes = {}
      for (const dll of assemblies) {
        const hash = digest(readFileSync(join(dest, dll)))
        next.assemblyHashes[dll] = hash
        // Reuse only the output of the same effective DLL at the same priority path.
        const output = basename(dll).replace(/\.dll$/i, '.decompiled.cs')
        const oldSource = join(live, 'Source-decompiled', output)
        if (old?.assemblyHashes?.[dll] === hash && existsSync(oldSource) &&
            assemblies.filter(p => basename(p).toLowerCase() === basename(dll).toLowerCase()).length === 1) {
          mkdirSync(join(dest, 'Source-decompiled'), { recursive: true })
          copyFileSync(oldSource, join(dest, 'Source-decompiled', output))
        }
      }
      next.decompileWarnings = decompileMod(ilspy, assemblies, dest, false, gameRoot)
      changed.push(mod.packageId)
    }
    next.warnings = [...mod.warnings, ...(next.decompileWarnings ?? [])]
    return next
  })
  return { mods, changed, foldersChanged }
}
