import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ModInfo } from '../../src/types'
import {
  computeEffectiveAssemblies,
  computeEffectiveFiles,
  selectLoadFolders,
  shouldLoadFolder,
} from '../../src/utils/load-folders'

const gameRoot = join(import.meta.dir, '../fixtures/game-root')

function mod(rootPath: string, overrides: Partial<ModInfo> = {}): ModInfo {
  return {
    packageId: 'test.mod',
    name: rootPath,
    source: 'local',
    rootPath,
    supportedVersions: ['1.6'],
    loadFolders: {},
    versionDirs: [],
    dependencies: [],
    loadAfter: [],
    loadBefore: [],
    incompatibleWith: [],
    warnings: [],
    dataCategory: undefined,
    ...overrides,
  }
}

const PROFILE = new Set(['ludeon.rimworld', 'beta.core', 'test.mod'])

describe('load-folders', () => {
  test('legacy: prefers <root>/<major.minor> when it exists', () => {
    const alpha = mod(join(gameRoot, 'Mods/AlphaTools'), {
      versionDirs: ['1.5', '1.6'],
    })
    expect(selectLoadFolders(alpha, '1.6.4871', PROFILE)).toEqual(['1.6', '.'])
  })

  test('legacy: falls back to the highest N.N folder <= current, then Common, then root', async () => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const temp = await mkdtemp(join(tmpdir(), 'rimsage-folders-'))
    try {
      await mkdir(join(temp, '1.4'), { recursive: true })
      await mkdir(join(temp, '1.5'), { recursive: true })
      await mkdir(join(temp, '1.7'), { recursive: true }) // above current: ignored
      await mkdir(join(temp, 'Common'), { recursive: true })
      const m = mod(temp, { versionDirs: ['1.4', '1.5', '1.7'] })
      expect(selectLoadFolders(m, '1.6.4871', PROFILE)).toEqual(['1.5', 'Common', '.'])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  test('LoadFolders.xml: exact -> highest <= current -> default (no Common/root appended)', () => {
    const gamma = mod(join(gameRoot, 'Mods/GammaConditional'), {
      loadFolders: {
        '1.5': [{ folderName: 'Old' }],
        '1.6': [
          { folderName: 'BetaOnly', requiredAnyOf: ['beta.core'] },
          { folderName: 'GammaBase' },
        ],
        default: [{ folderName: 'Defaults' }],
      },
    })

    // exact fallback path: highest defined <= 1.6.4871 is "1.6"
    expect(selectLoadFolders(gamma, '1.6.4871', PROFILE)).toEqual(['GammaBase', 'BetaOnly'])

    // current below every defined version -> "default"
    expect(selectLoadFolders(gamma, '1.4.3900', PROFILE)).toEqual(['Defaults'])

    // IfModActive filtered out when beta.core is not in the profile
    const withoutBeta = new Set(['ludeon.rimworld', 'test.mod'])
    expect(selectLoadFolders(gamma, '1.6.4871', withoutBeta)).toEqual(['GammaBase'])

    // AllOf/NotActive semantics with |postfix stripped on both sides
    const active = new Set(['a.mod|steam', 'b.mod'])
    expect(shouldLoadFolder({ folderName: 'X', requiredAllOf: ['a.mod', 'b.mod'] }, active)).toBe(true)
    expect(shouldLoadFolder({ folderName: 'X', requiredAllOf: ['a.mod', 'c.mod'] }, active)).toBe(false)
    expect(shouldLoadFolder({ folderName: 'X', disallowedAnyOf: ['b.mod'] }, active)).toBe(false)
    expect(shouldLoadFolder({ folderName: 'X', disallowedAnyOf: ['z.mod'] }, active)).toBe(true)

    // game version 1.5 selects the v1.5 key
    expect(selectLoadFolders(gamma, '1.5.4100', PROFILE)).toEqual(['Old'])
  })

  test('the last declared <li> has the highest priority (game AddFolders reverses)', () => {
    const m = mod('/mods/x', {
      loadFolders: {
        '1.6': [{ folderName: 'First' }, { folderName: 'Second' }],
      },
    })
    expect(selectLoadFolders(m, '1.6.4871', PROFILE)).toEqual(['Second', 'First'])
  })

  test('file shadowing: first (highest-priority) folder wins per relative key', () => {
    const alphaRoot = join(gameRoot, 'Mods/AlphaTools')
    const result = computeEffectiveFiles(alphaRoot, ['1.6', '.'])

    // 1.6/Defs/RootThing.xml shadows Defs/RootThing.xml
    expect(result.effective).toContain('1.6/Defs/RootThing.xml')
    expect(result.shadowed).toContain('Defs/RootThing.xml')

    // root-only files stay effective
    expect(result.effective).toContain('Defs/UniqueRoot.xml')

    // patches participate
    expect(result.effective).toContain('1.6/Patches/PatchOne.xml')

    // old version folders are not part of the active corpus
    expect(result.effective.every(f => !f.startsWith('1.5/'))).toBe(true)

    // "._" prefixed files are skipped entirely
    expect(result.effective.every(f => !f.includes('._'))).toBe(true)
    expect(result.shadowed.every(f => !f.includes('._'))).toBe(true)
  })

  test('assemblies: first folder wins per key, scanned recursively, no dotfile filter (game parity)', () => {
    const alphaRoot = join(gameRoot, 'Mods/AlphaTools')
    const alpha = computeEffectiveAssemblies(alphaRoot, ['1.6', '.'])

    // 1.6/Assemblies/Alpha.dll shadows the root copy
    expect(alpha).toContain('1.6/Assemblies/Alpha.dll')
    expect(alpha).not.toContain('Assemblies/Alpha.dll')

    // root-only dll stays effective (even 0Harmony.dll — the skip is a decompile concern, not a scan concern)
    expect(alpha).toContain('Assemblies/0Harmony.dll')

    const betaRoot = join(gameRoot, 'Mods/BetaCore')
    const beta = computeEffectiveAssemblies(betaRoot, ['.'])

    // recursive scan (ModContentPack: SearchOption.AllDirectories)
    expect(beta).toContain('Assemblies/Beta.dll')
    expect(beta).toContain('Assemblies/Sub/Nested.dll')
  })
})
