import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importVanilla } from '../../src/scripts/import-vanilla'
import { findIlspycmd } from '../../src/utils/decompile'
import { rmTemp } from '../helpers/fs'

let temp: string
let gameRoot: string
let distRoot: string
let source: string

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'rimsage vanilla '))
  gameRoot = join(temp, 'game')
  distRoot = join(temp, 'dist')
  source = join(distRoot, 'assets/Source')
  await Bun.write(join(gameRoot, 'Version.txt'), '1.7.5014 rev1195')
})

afterEach(async () => { await rmTemp(temp) })

test('rebuilds both XML trees, preserves categories, and removes obsolete source layouts', async () => {
  for (const kind of ['Defs', 'Patches']) {
    await Bun.write(join(gameRoot, 'Data/Core', kind, 'nested/Test.xml'), kind)
    await Bun.write(join(gameRoot, 'Data/Core', kind, '.hidden.xml'), 'hidden')
    await Bun.write(join(distRoot, 'assets', kind, 'Removed/Old.xml'), 'old')
  }
  await Bun.write(join(source, 'RimWorld/Pawn.cs'), 'old')
  await Bun.write(join(source, 'UnityStubs/Stale.cs'), 'removed dll')
  importVanilla({ gameRoot, distRoot, ilspyCmd: null })
  expect(readdirSync(source)).toEqual([])
  expect(await Bun.file(join(distRoot, 'Version.txt')).text()).toBe('1.7.5014 rev1195')
  for (const kind of ['Defs', 'Patches']) {
    const out = join(distRoot, 'assets', kind)
    expect(await Bun.file(join(out, 'Core/nested/Test.xml')).text()).toBe(kind)
    expect(existsSync(join(out, 'Removed'))).toBe(false)
    expect(existsSync(join(out, 'Core/.hidden.xml'))).toBe(false)
  }
  await Bun.write(join(gameRoot, 'Assembly-CSharp.dll'), 'dll')
  expect(() => importVanilla({ gameRoot, distRoot, ilspyCmd: null })).toThrow('ilspycmd')
  rmSync(join(gameRoot, 'Version.txt'))
  expect(() => importVanilla({ gameRoot, distRoot })).toThrow('Version.txt')
})

test.skipIf(!findIlspycmd())('decompiles fixture assemblies separately, incrementally, and with --full', async () => {
  const names = ['Assembly-CSharp', 'UnityStubs', 'RimWorldWaylith.PrepatcherCompat']
  for (const name of names) {
    copyFileSync(join(import.meta.dir, '../fixtures/dlls/ModAssembly.dll'), join(gameRoot, name + '.dll'))
  }
  importVanilla({ gameRoot, distRoot })
  for (const name of names) {
    const dir = join(source, name)
    expect([...new Bun.Glob('**/*.cs').scanSync(dir)].length).toBeGreaterThan(0)
    expect([...new Bun.Glob('**/*.csproj').scanSync(dir)]).toEqual([])
    await Bun.write(join(dir, 'Extra.cs'), 'marker')
  }
  // Only UnityStubs has an output older than the input DLL.
  utimesSync(join(source, 'UnityStubs'), new Date(0), new Date(0))
  importVanilla({ gameRoot, distRoot })
  expect(existsSync(join(source, 'Assembly-CSharp/Extra.cs'))).toBe(true)
  expect(existsSync(join(source, 'UnityStubs/Extra.cs'))).toBe(false)
  importVanilla({ gameRoot, distRoot, full: true })
  expect(existsSync(join(source, 'Assembly-CSharp/Extra.cs'))).toBe(false)

  await Bun.write(join(gameRoot, 'Assembly-CSharp.dll'), 'invalid')
  expect(() => importVanilla({ gameRoot, distRoot, full: true })).toThrow('Assembly-CSharp')
  expect(existsSync(join(source, 'Assembly-CSharp'))).toBe(false)
}, 30_000)
