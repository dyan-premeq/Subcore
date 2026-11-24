import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { rmTemp } from '../helpers/fs'
import { join } from 'node:path'
import {
  discoverMods,
  readModDir,
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

  test('warns on unsupported game versions', () => {
    const epsilon = byId.get('epsilon.oldstyle')!
    expect(epsilon.warnings.some(w => w.startsWith('unsupportedVersion'))).toBe(true)
  })

  test('merges per-version loadAfter data for the current major.minor', () => {
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

  test('1.7 reads metadata by path and document element, merging repeated load folder blocks in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rimsage-xml-'))
    try {
      await Bun.write(join(dir, 'About.xml'), '<metadata><packageId>ignored</packageId></metadata>')
      const read = () => readModDir(dir, 'local', 'dir-name', '1.7.5014')!
      expect(read().packageId).toBe('dir-name')
      await Bun.write(join(dir, 'aBoUt/ABOUT.XML'), '<?xml version="1.0"?><metadata><packageId>correct</packageId></metadata>')
      await Bun.write(join(dir, 'loadfolders.XML'), [
        '<?xml version="1.0"?><loadFolders>',
        '<v1.7><li>First</li></v1.7><V1.7><li>Second</li></V1.7><v1.7><li>Third</li><li>  Untrimmed  </li></v1.7>',
        '<default/></loadFolders>',
      ].join(''))
      expect(read().packageId).toBe('correct')
      expect(read().loadFolders).toEqual({
        '1.7': ['First', 'Second', 'Third', '  Untrimmed  '].map(folderName => ({ folderName })),
        default: [],
      })
    } finally {
      await rmTemp(dir)
    }
  })

  test('1.7 versioned metadata uses exact, then the single eligible supported fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rimsage-version-'))
    try {
      const read = async (supported: string[], blocks: string) => {
        const versions = supported.map(v => '<li>' + v + '</li>').join('')
        await Bun.write(join(dir, 'About/About.xml'),
          '<meta><supportedVersions>' + versions + '</supportedVersions><loadAfter><li>base</li></loadAfter>' +
          '<loadAfterByVersion>' + blocks + '</loadAfterByVersion></meta>')
        return readModDir(dir, 'local', 'test', '1.7.5014')!.loadAfter
      }
      const old = '<v1.6><li>old</li></v1.6>'
      const exact = '<V1.7><li>first</li></V1.7><V1.7><li>second</li></V1.7>'
      expect(await read(['1.7'], old)).toEqual(['base'])
      expect(await read([], old)).toEqual(['base'])
      expect(await read([], old + exact)).toEqual(['first'])
      expect(await read(['1.5', '1.6', '1.10'], old)).toEqual(['old'])
      expect(await read(['1.5'], old)).toEqual(['base'])
      expect(await read(['1.5'], '<v1.7/>')).toEqual([])
    } finally {
      await rmTemp(dir)
    }
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
