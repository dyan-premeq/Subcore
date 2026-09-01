// Optional decompilation of a mod's effective Assemblies into its dist copy
// (design doc §6.7). Uses the local ilspycmd with its default output — one
// <AssemblyName>.decompiled.cs per assembly. 0Harmony.dll is skipped: it is
// the Harmony library itself, already indexed as its own mod, and decompiling
// every bundled copy would duplicate megabytes of identical source.

import { spawnSync } from 'bun'
import { existsSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface DecompileStats {
  decompiled: number
  skipped: number
  failed: number
}

const DECOMPILED_DIR = 'Source-decompiled'

export function findIlspycmd(): string | null {
  return Bun.which('ilspycmd')
}

/**
 * Decompiles `assemblies` (mod-root-relative dll paths, as returned by
 * computeEffectiveAssemblies) from the mod's dist copy into
 * <destRoot>/Source-decompiled/. Incremental: an existing output newer than
 * its dll is kept. Missing ilspycmd disables the whole step (caller warns).
 */
export function decompileAssemblies(
  ilspyCmd: string,
  assemblies: string[],
  destRoot: string,
  full = false,
): DecompileStats {
  const stats: DecompileStats = { decompiled: 0, skipped: 0, failed: 0 }

  for (const relativeDll of assemblies) {
    const dllName = basename(relativeDll)
    if (dllName.toLowerCase() === '0harmony.dll') {
      stats.skipped += 1
      continue
    }

    const distDll = join(destRoot, relativeDll)
    if (!existsSync(distDll)) continue // not copied (should not happen)

    const outDir = join(destRoot, DECOMPILED_DIR)
    const outPath = join(
      outDir,
      dllName.replace(/\.dll$/i, '') + '.decompiled.cs',
    )

    if (!full && existsSync(outPath) &&
        statSync(outPath).mtimeMs >= statSync(distDll).mtimeMs) {
      stats.skipped += 1
      continue
    }

    const result = spawnSync({
      cmd: [ilspyCmd, '-o', outDir, distDll],
      stdout: 'ignore',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0 || !existsSync(outPath)) {
      // drop partial output so the incremental check never caches a failure
      if (existsSync(outPath)) rmSync(outPath)
      console.warn(
        `[decompile] ilspycmd failed on ${relativeDll} (exit ${result.exitCode}) — skipped.`,
      )
      stats.failed += 1
      continue
    }

    stats.decompiled += 1
  }

  return stats
}
