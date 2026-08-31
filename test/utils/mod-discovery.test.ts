import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  discoverMods,
  escapePackageDirName,
  parseVersionTxt,
} from '../../src/utils/mod-discovery'

const gameRoot = join(import.meta.dir, '../fixtures/game-root')

describe('mod-discovery', () => {
  const mods = discoverMods({
    gameRoot,
    workshopRoot: join(gameRoot, 'workshop'),
    gameVersion: '1.6.4871',
  })
  const byId = new Map(mods.map(mod => [mod.packageId, mod]))

  test('discovers builtin, dlc, local and workshop mods', () => {
    expect(byId.get('ludeon.rimworld')?.source).toBe('builtin')
    expect(byId.get('ludeon.rimworld')?.dataCategory).toBe('Core')
    expect(byId.get('ludeon.rimworld.royalty')?.source).toBe('dlc')
    expect(byId.get('alpha.tools')?.source).toBe('local')
    expect(byId.get('epsilon.oldstyle')?.source).toBe('workshop')
    expect(byId.get('epsilon.oldstyle')?.rootPath).toContain('294100')
  })

  test('normalizes packageIds and falls back to the directory name', () => {
    // About.xml declares "Alpha.Tools"; directory is "AlphaTools"
    expect(byId.has('alpha.tools')).toBe(true)
    expect(byId.get('alpha.tools')?.name).toBe('Alpha Tools')
    expect(byId.get('delta.noabout')).toBeDefined()
    expect(byId.get('delta.noabout')?.warnings.some(w => w.includes('missing About.xml'))).toBe(true)
  })

  test('warns on old-format About.xml and unsupported game versions', () => {
    const epsilon = byId.get('epsilon.oldstyle')!
    expect(epsilon.warnings.some(w => w.includes('old-format'))).toBe(true)
    expect(epsilon.warnings.some(w => w.startsWith('unsupportedVersion'))).toBe(true)
  })

  test('merges per-version loadAfter data (<= gameVersion, highest wins)', () => {
    const alpha = byId.get('alpha.tools')!
    expect(alpha.loadAfter).toEqual(['beta.core'])
    expect(alpha.dependencies).toEqual([{ packageId: 'beta.core', displayName: 'Beta Core' }])
  })

  test('parses LoadFolders.xml with normalized keys and lists legacy version dirs', () => {
    const alpha = byId.get('alpha.tools')!
    expect(Object.keys(alpha.loadFolders).sort()).toEqual(['1.5', '1.6'])
    // "/" means the mod root
    expect(alpha.loadFolders['1.6']?.map(e => e.folderName)).toEqual(['', '1.6'])
    expect(alpha.versionDirs).toEqual(['1.5', '1.6'])
  })

  test('escapes packageIds into dist directory names', () => {
    expect(escapePackageDirName('Alpha.Tools')).toBe('alpha.tools')
    expect(escapePackageDirName('Weird Mod!')).toBe('weird_mod_')
    expect(escapePackageDirName('normal.mod.sub')).toBe('normal.mod.sub')
  })

  test('parses Version.txt content down to the version token', () => {
    expect(parseVersionTxt('1.6.4871 rev590\n')).toBe('1.6.4871')
    expect(parseVersionTxt('1.6')).toBe('1.6')
    expect(parseVersionTxt('v1.5.4100')).toBe('1.5.4100')
    expect(parseVersionTxt('garbage')).toBeUndefined()
  })
})
