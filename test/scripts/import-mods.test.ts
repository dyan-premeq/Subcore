import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { write } from 'bun'
import { Database } from 'bun:sqlite'
import { importMods } from '../../src/scripts/import-mods'
import { rebuildModsIndex } from '../../src/scripts/index-mods'
import { listProfileMods } from '../../src/repositories/mods-repo'
import type { ModsRow } from '../../src/types'
import { findIlspycmd } from '../../src/utils/decompile'
import { computeEffectiveAssemblies } from '../../src/utils/load-folders'
import { rmTemp } from '../helpers/fs'

let gameRoot: string

let distRoot: string
let modsConfigPath: string

beforeAll(async () => {
  distRoot = await mkdtemp(join(tmpdir(), 'rimsage-import-mods-'))
  gameRoot = join(distRoot, 'game')
  await cp(join(import.meta.dir, '../fixtures/game-root'), gameRoot, { recursive: true })
  modsConfigPath = join(gameRoot, 'ModsConfig.xml')
})

afterAll(async () => {
  await rmTemp(distRoot)
})

async function run(full = false) {
  return importMods({
    gameRoot,
    gameVersion: '1.6.4871',
    workshopRoot: join(gameRoot, 'workshop'),
    modsConfigPath,
    profilePath: join(import.meta.dir, '../fixtures/profiles/dev-profile.json'),
    distModsPath: join(distRoot, 'assets/Mods'),
    manifestPath: join(distRoot, 'mods-manifest.json'),
    full,
  })
}

describe('import-mods', () => {
  test('copies the full mod structure and writes the manifest', async () => {
    const result = await run()

    // profile: beta -> alpha -> gamma (dependency order)
    const ordered = result.manifest.mods.map(mod => mod.packageId)
    expect(ordered.slice(0, 3)).toEqual([
      'ludeon.rimworld',
      'ludeon.rimworld.royalty',
      'beta.core',
    ])
    expect(ordered.indexOf('beta.core')).toBeLessThan(ordered.indexOf('alpha.tools'))
    expect(ordered.indexOf('alpha.tools')).toBeLessThan(ordered.indexOf('gamma.conditional'))

    // full structure copy incl. version folders and Languages...
    const alphaDist = join(distRoot, 'assets/Mods/alpha.tools')
    expect(existsSync(join(alphaDist, 'About/About.xml'))).toBe(true)
    expect(existsSync(join(alphaDist, '1.6/Defs/RootThing.xml'))).toBe(true)
    expect(existsSync(join(alphaDist, '1.5/Defs/OldDef.xml'))).toBe(true) // reference corpus
    expect(existsSync(join(alphaDist, 'Languages/English/Keyed/Strings.xml'))).toBe(true)

    // ...but skipping heavy asset dirs and hidden junk
    expect(existsSync(join(alphaDist, 'Textures'))).toBe(false)
    expect(existsSync(join(alphaDist, 'Defs/._Junk.xml'))).toBe(false)

    // root files: LoadFolders.xml copied
    expect(existsSync(join(alphaDist, 'LoadFolders.xml'))).toBe(true)

    // active folders per load-folders selection
    const alpha = result.manifest.mods.find(mod => mod.packageId === 'alpha.tools')!
    expect(alpha.loadOrder).toBe(3)
    expect(alpha.activeFolders).toEqual(['1.6', '.'])
    expect(alpha.effectiveFiles).toContain('1.6/Defs/RootThing.xml')
    expect(alpha.shadowedFiles).toContain('Defs/RootThing.xml')

    const gamma = result.manifest.mods.find(mod => mod.packageId === 'gamma.conditional')!
    expect(gamma.activeFolders).toEqual(['GammaBase', 'BetaOnly'])

    for (const mod of result.manifest.mods.filter(mod => mod.assetPath)) {
      const assemblies = computeEffectiveAssemblies(mod.rootPath, mod.activeFolders)
      for (const path of [...mod.effectiveFiles, ...assemblies]) {
        expect(existsSync(join(distRoot, 'assets', mod.assetPath, path))).toBe(true)
      }
    }

    // discovered but not in profile: metadata only
    const notInProfile = result.manifest.discoveredNotInProfile.map(mod => mod.packageId)
    expect(notInProfile).toContain('delta.noabout')
    expect(notInProfile).toContain('epsilon.oldstyle')
    expect(existsSync(join(distRoot, 'assets/Mods/delta.noabout'))).toBe(false)
  })

  test('is incremental: unchanged files are skipped, changed files recopied', async () => {
    const first = await run()
    const second = await run()
    expect(second.copiedFiles).toBe(0)
    expect(second.copiedFiles).toBeLessThanOrEqual(first.copiedFiles)

    const target = join(gameRoot, 'Mods/BetaCore/Defs/BetaThing.xml')
    await write(target, (await Bun.file(target).text()) + '\n')
    const third = await run()
    expect(third.copiedFiles).toBe(1)
  })

  test('mirrors only content at declared nested roots and prunes removed files and decompiles', async () => {
    const src = join(gameRoot, 'Mods/GammaConditional')
    const dest = join(distRoot, 'assets/Mods/gamma.conditional')
    const xmlPath = join(src, 'LoadFolders.xml')
    const original = await Bun.file(xmlPath).text()
    const nested = '1.7/Released/Biotech'
    await write(xmlPath, '<folders><v1.6><li>1.7</li><li>' + nested + '</li></v1.6></folders>')
    try {
      for (const path of ['1.7/Defs/A.xml', nested + '/Defs/B.xml', nested + '/Textures/X',
                          '1.7/Assets.zip', nested + '/Assets.zip.fingerprint', '1.7/Released/Defs/C.xml']) {
        await write(join(src, path), 'fixture')
      }
      await write(join(dest, 'Source-decompiled/Removed.decompiled.cs'), 'stale')
      const staleMod = join(distRoot, 'assets/Mods/removed.mod')
      await write(join(staleMod, 'Source/Stale.cs'), 'stale')
      await run()
      expect(existsSync(staleMod)).toBe(false)
      expect(existsSync(join(dest, '1.7/Defs/A.xml'))).toBe(true)
      expect(existsSync(join(dest, nested, 'Defs/B.xml'))).toBe(true)
      for (const path of ['1.7/Assets.zip', nested + '/Assets.zip.fingerprint', nested + '/Textures',
                          '1.7/Released/Defs', 'Source-decompiled/Removed.decompiled.cs', 'GammaBase']) {
        expect(existsSync(join(dest, path))).toBe(false)
      }
      await rm(join(src, '1.7/Defs/A.xml'))
      await run()
      expect(existsSync(join(dest, '1.7/Defs/A.xml'))).toBe(false)
    } finally {
      await write(xmlPath, original)
      await rm(join(src, '1.7'), { recursive: true, force: true })
    }
  })

  test('index-mods builds the mods table from the manifest', async () => {
    await run()
    const dbPath = join(distRoot, 'index.db')
    // inject a missing Version.txt so the manifest is the version authority
    // regardless of the repo's real dist/ contents
    await rebuildModsIndex(
      dbPath,
      join(distRoot, 'assets'),
      join(distRoot, 'mods-manifest.json'),
      join(distRoot, 'missing-Version.txt'),
    )

    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = listProfileMods(db)
      expect(rows).toHaveLength(5) // core + royalty + beta + alpha + gamma

      // discovered-but-not-in-profile mods land as metadata-only rows
      const delta = db
        .query<ModsRow, [string]>('SELECT * FROM mods WHERE packageId = ?')
        .get('delta.noabout')!
      expect(delta.loadOrder).toBe(-1)
      expect(delta.inProfile).toBe(0)
      expect(JSON.parse(delta.warnings ?? '[]').length).toBeGreaterThan(0)

      const alpha = rows.find(row => row.packageId === 'alpha.tools')!
      expect(JSON.parse(alpha.activeFolders ?? '[]')).toEqual(['1.6', '.'])

      // game version comes from the manifest when dist/Version.txt is absent
      const metaVersion = db
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'game_version'")
        .get()
      expect(metaVersion?.value).toBe('1.6.4871')
    } finally {
      db.close()
    }
  })

  test('index-mods fails loudly without any imported game version', async () => {
    const dbPath = join(distRoot, 'index.db')
    // no manifest + no version file -> no version authority
    await expect(
      rebuildModsIndex(
        dbPath,
        join(distRoot, 'assets'),
        join(distRoot, 'no-such-manifest.json'),
        join(distRoot, 'missing-Version.txt'),
      ),
    ).rejects.toThrow('import:vanilla')
  })

  const ilspy = findIlspycmd()
  test.skipIf(!ilspy)('decompiles effective assemblies into Source-decompiled (skips 0Harmony, ignores shadowed dlls)', async () => {
    await run(true)

    const betaDist = join(distRoot, 'assets/Mods/beta.core')
    expect(existsSync(join(betaDist, 'Source-decompiled/Beta.decompiled.cs'))).toBe(true)
    // recursive Assemblies scan (game: SearchOption.AllDirectories)
    expect(existsSync(join(betaDist, 'Source-decompiled/Nested.decompiled.cs'))).toBe(true)

    const alphaDist = join(distRoot, 'assets/Mods/alpha.tools')
    // 1.6/Assemblies/Alpha.dll is the effective copy (root copy shadowed)
    expect(existsSync(join(alphaDist, 'Source-decompiled/Alpha.decompiled.cs'))).toBe(true)
    // the Harmony library itself is never decompiled
    expect(existsSync(join(alphaDist, 'Source-decompiled/0Harmony.decompiled.cs'))).toBe(false)
  })

  test('failed decompiles land in the manifest warnings with dll names', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'rimsage-import-decomp-fail-'))
    try {
      const result = await importMods({
        gameRoot,
        gameVersion: '1.6.4871',
        workshopRoot: join(gameRoot, 'workshop'),
        modsConfigPath,
        profilePath: join(import.meta.dir, '../fixtures/profiles/dev-profile.json'),
        distModsPath: join(dist, 'assets/Mods'),
        manifestPath: join(dist, 'mods-manifest.json'),
        ilspyCmd: writeFailingIlspy(dist),
      })

      // beta.core: Assemblies/Beta.dll + Assemblies/Sub/Nested.dll, both attempted
      const beta = result.manifest.mods.find(mod => mod.packageId === 'beta.core')!
      const warning = beta.warnings.find(w => w.includes('failed to decompile'))
      expect(warning).toMatch(/^2 assembly\(ies\) failed to decompile: /)
      expect(warning).toContain('Beta.dll')
      expect(warning).toContain('Nested.dll')

      // no Assemblies -> no decompile warning
      const gamma = result.manifest.mods.find(mod => mod.packageId === 'gamma.conditional')!
      expect(gamma.warnings.some(w => w.includes('decompil'))).toBe(false)
    } finally {
      await rmTemp(dist)
    }
  })

  test('missing ilspycmd: mods with assemblies get the not-installed warning', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'rimsage-import-decomp-missing-'))
    try {
      const result = await importMods({
        gameRoot,
        gameVersion: '1.6.4871',
        workshopRoot: join(gameRoot, 'workshop'),
        modsConfigPath,
        profilePath: join(import.meta.dir, '../fixtures/profiles/dev-profile.json'),
        distModsPath: join(dist, 'assets/Mods'),
        manifestPath: join(dist, 'mods-manifest.json'),
        ilspyCmd: null,
      })

      const beta = result.manifest.mods.find(mod => mod.packageId === 'beta.core')!
      expect(beta.warnings).toContain('assemblies not decompiled (ilspycmd not installed)')

      // gamma.conditional has no Assemblies -> untouched
      const gamma = result.manifest.mods.find(mod => mod.packageId === 'gamma.conditional')!
      expect(gamma.warnings.some(w => w.includes('ilspycmd'))).toBe(false)
    } finally {
      await rmTemp(dist)
    }
  })

  test('regression: nothing failed -> warnings stay discovery-only', async () => {
    const result = await run()
    const withAssemblies = new Set(['beta.core', 'alpha.tools'])
    for (const mod of result.manifest.mods) {
      expect(mod.warnings.some(w => w.includes('failed to decompile'))).toBe(false)
      if (!withAssemblies.has(mod.packageId)) {
        expect(mod.warnings.some(w => w.includes('ilspycmd'))).toBe(false)
      }
    }
  })
})

/** An ilspycmd stand-in that always exits 1, exercising the decompile-failure path. */
function writeFailingIlspy(dir: string): string {
  if (process.platform === 'win32') {
    const script = join(dir, 'failing-ilspy.cmd')
    writeFileSync(script, '@exit /b 1\r\n')
    return script
  }
  const script = join(dir, 'failing-ilspy.sh')
  writeFileSync(script, '#!/bin/sh\nexit 1\n')
  chmodSync(script, 0o755)
  return script
}

