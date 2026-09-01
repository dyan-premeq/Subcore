import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { write } from 'bun'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchSource, searchSourceImpl } from '../../src/tools/search-source'
import { PathSandbox } from '../../src/utils/path-sandbox'

describe('search-source', () => {
  let testDir: string
  let sandbox: PathSandbox

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'rimsage-search-source-'))
    sandbox = new PathSandbox(testDir)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('supports case-sensitive and case-insensitive searches', async () => {
    await write(join(testDir, 'test.ts'), 'Hello\nhello')

    const insensitive = await searchSourceImpl(sandbox, 'hello')
    const sensitive = await searchSourceImpl(sandbox, 'hello', true)

    expect(insensitive.output).toContain('Hello')
    expect(insensitive.output).toContain('hello')
    expect(sensitive.output).not.toContain('Hello')
    expect(sensitive.output).toContain('hello')
  })

  test('filters results by file pattern', async () => {
    await write(join(testDir, 'test.ts'), 'needle')
    await write(join(testDir, 'test.js'), 'needle')

    const result = await searchSourceImpl(sandbox, 'needle', false, '*.ts')

    expect(result.output).toContain('test.ts')
    expect(result.output).not.toContain('test.js')
  })

  test('returns guidance when nothing matches', async () => {
    await write(join(testDir, 'test.ts'), 'content')

    const text = (await searchSource(sandbox, 'missing')).content[0].text

    expect(text).toBe(
      'No results found. Try adjusting your search query or file pattern.',
    )
  })

  test('limits output by result count', async () => {
    const content = Array.from({ length: 450 }, (_, i) => `hit ${i}`).join('\n')
    await write(join(testDir, 'many.txt'), content)

    const text = (await searchSource(sandbox, 'hit')).content[0].text

    expect(text).toContain('[TRUNCATED] Showing 400/')
  })

  test('limits output by byte size', async () => {
    await write(join(testDir, 'large.txt'), 'x'.repeat(120 * 1024))

    const text = (await searchSource(sandbox, 'x')).content[0].text
    const output = text.split('\n\n[TRUNCATED]')[0]

    expect(text).toContain('[TRUNCATED] Output size exceeded 100KB.')
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
      100 * 1024,
    )
  })

  test('propagates invalid regular expressions', async () => {
    await write(join(testDir, 'test.ts'), 'hello')

    expect(searchSource(sandbox, '[abc')).rejects.toThrow()
  })
})

describe('search-source scope', () => {
  let testDir: string
  let sandbox: PathSandbox

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'rimsage-scope-'))
    sandbox = new PathSandbox(testDir)
    await write(join(testDir, 'Defs', 'vanilla.xml'), 'target_vanilla')
    await write(join(testDir, 'Mods/m1/1.6/Defs/active.xml'), 'target_mod_active')
    await write(join(testDir, 'Mods/m1/1.5/Defs/old.xml'), 'target_mod_old')
    await write(join(testDir, 'Mods/m1/Defs/shadowed.xml'), 'target_mod_shadowed')
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('scope=vanilla searches only game Defs/Source', async () => {
    const result = await searchSourceImpl(sandbox, 'target_', false, undefined, {
      scope: 'vanilla',
    })
    expect(result.output).toContain('vanilla.xml')
    expect(result.output).not.toContain('Mods')
  })

  test('scope=mods searches only imported mods', async () => {
    const result = await searchSourceImpl(sandbox, 'target_', false, undefined, {
      scope: 'mods',
    })
    expect(result.output).toContain('active.xml')
    expect(result.output).not.toContain('vanilla.xml')
  })

  test('scope=packageId searches one mod; unknown ids yield guidance', async () => {
    const result = await searchSourceImpl(sandbox, 'target_', false, undefined, {
      scope: 'm1',
    })
    expect(result.output).toContain('active.xml')
    expect(result.output).not.toContain('vanilla.xml')

    const unknown = await searchSourceImpl(sandbox, 'target_', false, undefined, {
      scope: 'nope.mod',
    })
    expect(unknown.guidance).toContain('nope.mod')
  })



  test('loaded_only=true excludes non-active version folders and shadowed files', async () => {
    const manifest = {
      generatedAt: '',
      gameVersion: '1.6',
      profile: { name: 't', base: 'all-dlc' as const, mods: ['m1'], autoOrder: true },
      mods: [
        {
          packageId: 'm1',
          name: 'm1',
          source: 'local' as const,
          rootPath: '/mods/m1',
          assetPath: 'Mods/m1',
          loadOrder: 1,
          inProfile: true,
          supportedVersions: [],
          loadFolders: {},
          versionDirs: ['1.5'],
          dependencies: [],
          loadAfter: [],
          loadBefore: [],
          incompatibleWith: [],
          warnings: [],
          activeFolders: ['1.6', '.'],
          effectiveFiles: ['1.6/Defs/active.xml'],
          shadowedFiles: ['Defs/shadowed.xml'],
          issues: [],
        },
      ],
      discoveredNotInProfile: [],
    }

    const loaded = await searchSourceImpl(sandbox, 'target_mod', false, undefined, {
      scope: 'mods',
      loadedOnly: true,
      manifest,
    })
    expect(loaded.output).toContain('active.xml')
    expect(loaded.output).not.toContain('old.xml')
    expect(loaded.output).not.toContain('shadowed.xml')

    const everything = await searchSourceImpl(sandbox, 'target_mod', false, undefined, {
      scope: 'mods',
    })
    expect(everything.output).toContain('old.xml')
    expect(everything.output).toContain('shadowed.xml')
  })
})
