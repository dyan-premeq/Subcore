// Decompile each mod assembly to a single C# file for indexing.

import { spawnSync } from 'bun'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface DecompileStats {
  decompiled: number
  skipped: number
  /** Basenames of dlls ilspycmd failed on; drives mod.warnings. */
  failed: string[]
}

const DECOMPILED_DIR = 'Source-decompiled'
const HARMONY_LIBRARIES = new Set(['0harmony.dll', 'harmonymod.runtimeil.dll'])

const IL_COMMENT_LINE = /^\s*\/\/IL_[0-9A-Fa-f]+:/

/**
 * Rewrites `path` without ilspycmd's `//IL_xxxx: Unknown result type...` noise
 * lines (2354 in one observed file). Must happen at build time, before the
 * csharp index bakes `startLine`, so served line numbers stay in sync with the
 * file.
 */
export function stripIlComments(path: string): void {
  const lines = readFileSync(path, 'utf8').split('\n')
  const kept = lines.filter((line) => !IL_COMMENT_LINE.test(line))
  if (kept.length !== lines.length) writeFileSync(path, kept.join('\n'))
}

export function findIlspycmd(): string | null {
  return Bun.which('ilspycmd')
}

/**
 * Decompiles `assemblies` (mod-root-relative dll paths, as returned by
 * computeEffectiveAssemblies) from the mod's dist copy into
 * <destRoot>/Source-decompiled/. Incremental: an existing output newer than
 * its dll is kept. Obsolete outputs are pruned even when ilspycmd is missing.
 */
export function decompileAssemblies(
  ilspyCmd: string | null,
  assemblies: string[],
  destRoot: string,
  full = false,
  gameRoot?: string,
): DecompileStats {
  const stats: DecompileStats = { decompiled: 0, skipped: 0, failed: [] }

  const targets = assemblies.filter(path =>
    !HARMONY_LIBRARIES.has(basename(path).toLowerCase()))
  stats.skipped = assemblies.length - targets.length
  const outDir = join(destRoot, DECOMPILED_DIR)
  const outputName = (dll: string) => basename(dll).replace(/\.dll$/i, '.decompiled.cs')
  const outputs = new Set(targets.map(outputName))
  if (existsSync(outDir)) {
    for (const name of readdirSync(outDir)) {
      if (name.endsWith('.decompiled.cs') && !outputs.has(name)) rmSync(join(outDir, name))
    }
  }
  if (!ilspyCmd) return stats
  const references = gameRoot && existsSync(gameRoot) ? ['-r', gameRoot] : []
  for (const relativeDll of targets) {
    const dllName = basename(relativeDll)
    const distDll = join(destRoot, relativeDll)
    if (!existsSync(distDll)) continue // not copied (should not happen)

    const outPath = join(outDir, outputName(relativeDll))

    if (!full && existsSync(outPath) &&
        statSync(outPath).mtimeMs >= statSync(distDll).mtimeMs) {
      stats.skipped += 1
      continue
    }

    const result = spawnSync({
      cmd: [ilspyCmd, ...references, '-o', outDir, distDll, '--disable-updatecheck'],
      stdout: 'ignore',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0 || !existsSync(outPath)) {
      // drop partial output so the incremental check never caches a failure
      if (existsSync(outPath)) rmSync(outPath)
      console.warn(
        `[decompile] ilspycmd failed on ${relativeDll} (exit ${result.exitCode}) — skipped.`,
      )
      stats.failed.push(dllName)
      continue
    }

    stripIlComments(outPath)

    stats.decompiled += 1
  }

  return stats
}
