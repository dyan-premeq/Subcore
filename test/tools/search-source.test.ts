import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { write } from 'bun'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchSource, searchSourceImpl } from '../../src/tools/search-source'
import { ensureSchema } from '../../src/db/schema'
import { indexSourceFiles } from '../../src/scripts/index-source'
import { PathSandbox } from '../../src/utils/path-sandbox'

describe('search-source', () => {
  let testDir: string
  let sandbox: PathSandbox
  let db: Database

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'rimsage-search-source-'))
    sandbox = new PathSandbox(testDir)
    db = new Database(':memory:')
    ensureSchema(db)
    await indexSourceFiles(db, testDir)
  })

  afterEach(async () => {
    db.close()
    await rm(testDir, { recursive: true, force: true })
  })

  test('supports case-sensitive and case-insensitive searches', async () => {
    await write(join(testDir, 'test.ts'), 'Hello\nhello')
    await indexSourceFiles(db, testDir)

    const insensitive = await searchSourceImpl(db, sandbox, 'hello')
    const sensitive = await searchSourceImpl(db, sandbox, 'hello', true)

    expect(insensitive.output).toContain('Hello')
    expect(insensitive.output).toContain('hello')
    expect(sensitive.output).not.toContain('Hello')
    expect(sensitive.output).toContain('hello')
  })

  test('filters results by file pattern', async () => {
    await write(join(testDir, 'test.ts'), 'needle')
    await write(join(testDir, 'test.js'), 'needle')
    await indexSourceFiles(db, testDir)

    const result = await searchSourceImpl(db, sandbox, 'needle', false, '*.ts')

    expect(result.output).toContain('test.ts')
    expect(result.output).not.toContain('test.js')
  })

  test('returns an empty-result message echoing the query and scope', async () => {
    await write(join(testDir, 'test.ts'), 'content')
    await indexSourceFiles(db, testDir)

    const text = (await searchSource(db, sandbox, 'missing')).content[0].text

    expect(text).toBe(`No matches for /missing/ in scope 'all'`)
  })

  test('empty result echoes file_pattern without the glob note for a bare pattern', async () => {
    await write(join(testDir, 'test.ts'), 'content')
    await indexSourceFiles(db, testDir)

    const text = (await searchSource(db, sandbox, 'missing', false, '*.ts')).content[0]
      .text as string

    expect(text).toBe(`No matches for /missing/ in scope 'all', file_pattern '*.ts'`)
  })

  test('single-star glob crossing "/" gets the gitignore-semantics note', async () => {
    const text = (await searchSource(db, sandbox, 'missing', false, 'Mods/m1/*')).content[0]
      .text as string

    expect(text).toBe(
      `No matches for /missing/ in scope 'all', file_pattern 'Mods/m1/*'\n` +
        `Note: globs use gitignore semantics — a single '*' does not cross '/'; to limit to one mod use scope:'<packageId>' instead.`,
    )
  })

  test('double-star glob does not get the gitignore-semantics note', async () => {
    const text = (
      await searchSource(db, sandbox, 'missing', false, 'Mods/m1/**', { scope: 'vanilla' })
    ).content[0].text as string

    expect(text).toBe(`No matches for /missing/ in scope 'vanilla', file_pattern 'Mods/m1/**'`)
  })

  test('limits output by result count', async () => {
    const content = Array.from({ length: 450 }, (_, i) => `hit ${i}`).join('\n')
    await write(join(testDir, 'many.txt'), content)
    await indexSourceFiles(db, testDir)

    const text = (await searchSource(db, sandbox, 'hit')).content[0].text

    expect(text).toContain('[TRUNCATED] Showing 400/')
  })

  test('a smaller limit caps result lines and the truncation hint reports it', async () => {
    const content = Array.from({ length: 450 }, (_, i) => `hit ${i}`).join('\n')
    await write(join(testDir, 'many.txt'), content)
    await indexSourceFiles(db, testDir)

    const text = (
      await searchSource(db, sandbox, 'hit', false, undefined, { limit: 30 })
    ).content[0].text as string

    // line-based like the 400 cap: rg's --heading filename line takes a slot
    expect(text).toContain('[TRUNCATED] Showing 30/451 results.')
    const resultLines = text.split(/\r?\n/).filter(line => line.includes('hit '))
    expect(resultLines).toHaveLength(29)
  })

  test('limits output by byte size', async () => {
    await write(join(testDir, 'large.txt'), 'x'.repeat(120 * 1024))
    await indexSourceFiles(db, testDir)

    const text = (await searchSource(db, sandbox, 'x')).content[0].text
    const output = text.split('\n\n[TRUNCATED]')[0]

    expect(text).toContain('[TRUNCATED] Output size exceeded 100KB.')
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
      100 * 1024,
    )
  })

  test('propagates invalid regular expressions', async () => {
    await write(join(testDir, 'test.ts'), 'hello')
    await indexSourceFiles(db, testDir)

    expect(searchSource(db, sandbox, '[abc')).rejects.toThrow()
  })

  test('FTS path matches a fragment inside one token; case-sensitive query misses', async () => {
    await write(join(testDir, 'Defs', 'Races.xml'), '<alienrefugeekinds>2</alienrefugeekinds>')
    await indexSourceFiles(db, testDir)

    const hit = await searchSourceImpl(db, sandbox, 'refugee')
    expect(hit.output).toContain('alienrefugeekinds')

    const sensitiveMiss = await searchSourceImpl(db, sandbox, 'Refugee', true)
    expect(sensitiveMiss.output).toBe('')
  })

  test('a plain identifier (FTS path) and its regex equivalent (rg path) agree line by line', async () => {
    await write(join(testDir, 'Defs', 'a.txt'), 'hello world\nnope\nsay HELLO\n')
    await indexSourceFiles(db, testDir)

    // compared after the wrapper's heading normalization: Windows rg emits
    // backslash separators, the FTS path emits posix
    const fts = await searchSource(db, sandbox, 'hello', false, undefined, { scope: 'vanilla' })
    const viaRg = await searchSource(db, sandbox, '(?:hello)', false, undefined, {
      scope: 'vanilla',
    })

    expect(fts.content[0].text!.split('\n')).toEqual(viaRg.content[0].text!.split('\n'))
  })

  test('FTS path stops reading files once the output passes 100KB', async () => {
    await write(join(testDir, 'big1.txt'), 'x'.repeat(60 * 1024))
    await write(join(testDir, 'big2.txt'), 'x'.repeat(60 * 1024))
    await indexSourceFiles(db, testDir)

    const text = (await searchSource(db, sandbox, 'x')).content[0].text as string

    expect(text).toContain('[TRUNCATED] Output size exceeded 100KB.')
  })
})

describe('search-source scope', () => {
  let testDir: string
  let sandbox: PathSandbox
  let db: Database

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'rimsage-scope-'))
    sandbox = new PathSandbox(testDir)
    await write(join(testDir, 'Defs', 'vanilla.xml'), 'target_vanilla')
    await write(join(testDir, 'Mods/m1/1.6/Defs/active.xml'), 'target_mod_active')
    await write(join(testDir, 'Mods/m1/1.5/Defs/old.xml'), 'target_mod_old')
    await write(join(testDir, 'Mods/m1/Defs/shadowed.xml'), 'target_mod_shadowed')
    db = new Database(':memory:')
    ensureSchema(db)
    await indexSourceFiles(db, testDir)
  })

  afterEach(async () => {
    db.close()
    await rm(testDir, { recursive: true, force: true })
  })

  test('scope=vanilla searches only game Defs/Source', async () => {
    const result = await searchSourceImpl(db, sandbox, 'target_', false, undefined, {
      scope: 'vanilla',
    })
    expect(result.output).toContain('vanilla.xml')
    expect(result.output).not.toContain('Mods')
  })

  test('scope=mods searches only imported mods', async () => {
    const result = await searchSourceImpl(db, sandbox, 'target_', false, undefined, {
      scope: 'mods',
    })
    expect(result.output).toContain('active.xml')
    expect(result.output).not.toContain('vanilla.xml')
  })

  test('scope=packageId searches one mod; unknown ids yield guidance', async () => {
    const result = await searchSourceImpl(db, sandbox, 'target_', false, undefined, {
      scope: 'm1',
    })
    expect(result.output).toContain('active.xml')
    expect(result.output).not.toContain('vanilla.xml')

    const unknown = await searchSourceImpl(db, sandbox, 'target_', false, undefined, {
      scope: 'nope.mod',
    })
    expect(unknown.guidance).toContain('nope.mod')
  })

  test('scope "Mods/<packageId>" (any case) resolves like the bare packageId', async () => {
    const bare = await searchSourceImpl(db, sandbox, 'target_', false, undefined, {
      scope: 'm1',
    })
    expect(bare.output).toContain('active.xml')

    const sorted = (s: string) => s.split('\n').sort().join('\n')
    for (const scope of ['Mods/m1', 'mods/m1', 'MODS/m1']) {
      const prefixed = await searchSourceImpl(db, sandbox, 'target_', false, undefined, { scope })
      expect(sorted(prefixed.output)).toBe(sorted(bare.output))
    }
  })

  test('unknown scope guidance lists the four valid forms', async () => {
    const unknown = await searchSourceImpl(db, sandbox, 'target_', false, undefined, {
      scope: 'Source',
    })
    expect(unknown.guidance).toContain('Unknown scope "Source"')
    expect(unknown.guidance).toContain('Valid:')
    expect(unknown.guidance).toContain("'all'")
    expect(unknown.guidance).toContain("'vanilla'")
    expect(unknown.guidance).toContain("'mods'")
    expect(unknown.guidance).toContain('packageId')
    expect(unknown.guidance).not.toContain('dist/')
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

    const loaded = await searchSourceImpl(db, sandbox, 'target_mod', false, undefined, {
      scope: 'mods',
      loadedOnly: true,
      manifest,
    })
    expect(loaded.output).toContain('active.xml')
    expect(loaded.output).not.toContain('old.xml')
    expect(loaded.output).not.toContain('shadowed.xml')

    const everything = await searchSourceImpl(db, sandbox, 'target_mod', false, undefined, {
      scope: 'mods',
    })
    expect(everything.output).toContain('old.xml')
    expect(everything.output).toContain('shadowed.xml')
  })

  test('FTS path file_pattern: basename glob without "/", anchored glob with "/"', async () => {
    await write(join(testDir, 'Mods/m1/1.6/Source/Util.cs'), 'target_cs')
    await write(join(testDir, 'Mods/m1/1.6/Defs/Deep.xml'), 'target_cs')
    await write(join(testDir, 'Defs/nested/Vanilla.xml'), 'target_xml')
    await indexSourceFiles(db, testDir)

    // no '/' in the pattern: rg matches it against the basename only, so the
    // in-scope Deep.xml is excluded despite matching the query
    const csOnly = await searchSourceImpl(db, sandbox, 'target_cs', false, '*.cs', {
      scope: 'm1',
    })
    expect(csOnly.output).toContain('Util.cs')
    expect(csOnly.output).not.toContain('Deep.xml')

    // anchored: matches the whole sandbox-relative path from the root
    const anchored = await searchSourceImpl(db, sandbox, 'target_', false, 'Defs/**/*.xml')
    expect(anchored.output).toContain('Defs/nested/Vanilla.xml')
    expect(anchored.output).not.toContain('Util.cs')
    expect(anchored.output).not.toContain('Mods')
  })

  test('regex queries keep rg semantics on the rg path', async () => {
    const alternation = await searchSourceImpl(db, sandbox, 'target_mod_(active|old)', false, undefined, {
      scope: 'mods',
    })
    expect(alternation.output).toContain('active.xml')
    expect(alternation.output).toContain('old.xml')
    expect(alternation.output).not.toContain('shadowed.xml')
    expect(alternation.output).not.toContain('vanilla.xml')
  })
})
