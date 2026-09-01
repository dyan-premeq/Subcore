import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { decompileAssemblies, findIlspycmd } from '../../src/utils/decompile'
import { rmTemp } from '../helpers/fs'

const fixtureDll = join(import.meta.dir, '../fixtures/dlls/ModAssembly.dll')

describe('decompile', () => {
  test('skips 0Harmony.dll without touching ilspycmd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rimsage-decompile-'))
    try {
      mkdirSync(join(dir, 'Assemblies'), { recursive: true })
      copyFileSync(fixtureDll, join(dir, 'Assemblies/0Harmony.dll'))

      // 'definitely-not-installed' never spawns: the skip happens first
      const stats = decompileAssemblies('definitely-not-installed', ['Assemblies/0Harmony.dll'], dir)
      expect(stats).toEqual({ decompiled: 0, skipped: 1, failed: 0 })
    } finally {
      await rmTemp(dir)
    }
  })

  const ilspy = findIlspycmd()
  test.skipIf(!ilspy)('decompiles once, then skips incrementally, then re-decompiles after change', () => {
    const dir = mkdtempSync('rimsage-decompile-real-')
    try {
      mkdirSync(join(dir, 'Assemblies'), { recursive: true })
      copyFileSync(fixtureDll, join(dir, 'Assemblies/ModAssembly.dll'))

      const first = decompileAssemblies(ilspy!, ['Assemblies/ModAssembly.dll'], dir)
      expect(first.decompiled).toBe(1)
      const outPath = join(dir, 'Source-decompiled/ModAssembly.decompiled.cs')
      expect(existsSync(outPath)).toBe(true)

      const second = decompileAssemblies(ilspy!, ['Assemblies/ModAssembly.dll'], dir)
      expect(second.skipped).toBe(1)

      // a newer dll invalidates the cached output
      utimesSync(join(dir, 'Assemblies/ModAssembly.dll'), new Date(), new Date(Date.now() + 5000))
      const third = decompileAssemblies(ilspy!, ['Assemblies/ModAssembly.dll'], dir)
      expect(third.decompiled).toBe(1)
    } finally {
      rmSyncSync(dir)
    }
  })

  test.skipIf(!ilspy)('garbage dlls fail gracefully with a warning, not a crash', () => {
    const dir = mkdtempSync('rimsage-decompile-garbage-')
    try {
      mkdirSync(join(dir, 'Assemblies'), { recursive: true })
      writeFileSync(join(dir, 'Assemblies/Bad.dll'), 'not a dll')

      const stats = decompileAssemblies(ilspy!, ['Assemblies/Bad.dll'], dir)
      expect(stats.failed).toBe(1)
      // ilspycmd may pre-create the output dir; no usable output may exist
      expect(existsSync(join(dir, 'Source-decompiled/Bad.decompiled.cs'))).toBe(false)
    } finally {
      rmSyncSync(dir)
    }
  })
})

function mkdtempSync(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function rmSyncSync(path: string): void {
  rmTemp(path) // async tolerant rm; fire and forget is fine in tests
}
