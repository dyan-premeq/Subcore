import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
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
      expect(stats).toEqual({ decompiled: 0, skipped: 1, failed: [] })
    } finally {
      await rmTemp(dir)
    }
  })

  test('strips //IL_ comment lines from freshly decompiled output', () => {
    const dir = mkdtempSync('rimsage-decompile-strip-')
    try {
      // seed the artifact the fake "ilspycmd" pretends to have written:
      // IL noise lines (top-level and indented, upper/lowercase hex) mixed with real code
      const outDir = join(dir, 'Source-decompiled')
      mkdirSync(outDir, { recursive: true })
      const outPath = join(outDir, 'ModAssembly.decompiled.cs')
      writeFileSync(outPath, [
        'using System;',
        '//IL_0000: Unknown result type (might be due to invalid IL or missing references)',
        'namespace RimSage.Fixture',
        '{',
        '    //IL_0020: Unknown result type (might be due to invalid IL or missing references)',
        '    //IL_00aF: invalid IL code',
        '    public static class ModAssembly',
        '    {',
        '        // not an IL marker: kept',
        '        //IL_note: non-hex suffix is not a marker: kept',
        '        public const string Path = "//IL_0041: mid-line: kept";',
        '    }',
        '}',
        '',
      ].join('\n'))

      const fakeIlspy = writeFakeIlspy(dir)

      // copy the dll after seeding the output so its mtime is newer (guard must not skip);
      // utimesSync because Windows mtime granularity can leave the copy equal to the seed
      mkdirSync(join(dir, 'Assemblies'), { recursive: true })
      copyFileSync(fixtureDll, join(dir, 'Assemblies/ModAssembly.dll'))
      utimesSync(join(dir, 'Assemblies/ModAssembly.dll'), new Date(), new Date(Date.now() + 5000))

      const stats = decompileAssemblies(fakeIlspy, ['Assemblies/ModAssembly.dll'], dir)
      expect(stats).toEqual({ decompiled: 1, skipped: 0, failed: [] })

      const stripped = readFileSync(outPath, 'utf8')
      const ilLines = stripped.split('\n').filter((line) => /^\s*\/\/IL_[0-9A-Fa-f]+:/.test(line))
      expect(ilLines).toEqual([]) // zero //IL_ marker lines survive
      expect(stripped).toBe([
        'using System;',
        'namespace RimSage.Fixture',
        '{',
        '    public static class ModAssembly',
        '    {',
        '        // not an IL marker: kept',
        '        //IL_note: non-hex suffix is not a marker: kept',
        '        public const string Path = "//IL_0041: mid-line: kept";',
        '    }',
        '}',
        '',
      ].join('\n')) // every real line byte-for-byte intact
    } finally {
      rmSyncSync(dir)
    }
  })

  const ilspy = findIlspycmd()
  // 30s: spawns the real ilspycmd twice; observed ~5s on cold start, past bun's 5s default
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
  }, 30000)

  test.skipIf(!ilspy)('garbage dlls fail gracefully with a warning, not a crash', () => {
    const dir = mkdtempSync('rimsage-decompile-garbage-')
    try {
      mkdirSync(join(dir, 'Assemblies'), { recursive: true })
      writeFileSync(join(dir, 'Assemblies/Bad.dll'), 'not a dll')

      const stats = decompileAssemblies(ilspy!, ['Assemblies/Bad.dll'], dir)
      expect(stats.failed).toEqual(['Bad.dll'])
      // ilspycmd may pre-create the output dir; no usable output may exist
      expect(existsSync(join(dir, 'Source-decompiled/Bad.decompiled.cs'))).toBe(false)
    } finally {
      rmSyncSync(dir)
    }
  }, 30000)
})

function mkdtempSync(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A no-op stand-in for ilspycmd: exits 0, ignores its `-o dir dll` args. The
 *  caller pre-seeds the output file, so the success path runs on our content. */
function writeFakeIlspy(dir: string): string {
  if (process.platform === 'win32') {
    const script = join(dir, 'fake-ilspy.cmd')
    writeFileSync(script, '@exit /b 0\r\n')
    return script
  }
  const script = join(dir, 'fake-ilspy.sh')
  writeFileSync(script, '#!/bin/sh\nexit 0\n')
  chmodSync(script, 0o755)
  return script
}

function rmSyncSync(path: string): void {
  rmTemp(path) // async tolerant rm; fire and forget is fine in tests
}
