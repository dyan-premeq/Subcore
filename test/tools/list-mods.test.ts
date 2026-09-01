import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { listMods } from '../../src/tools/list-mods'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'

let db: Database

function mod(
  packageId: string,
  loadOrder: number,
  overrides: Partial<ModInsertRow> = {},
): ModInsertRow {
  return {
    packageId,
    name: packageId,
    source: 'workshop',
    assetPath: '',
    loadOrder,
    inProfile: loadOrder >= 0,
    activeFolders: null,
    warnings: [],
    dataCategory: null,
    ...overrides,
  }
}

beforeAll(() => {
  db = new Database(':memory:')
  ensureSchema(db)
  replaceMods(db, [
    mod('ludeon.rimworld', 0, { source: 'builtin', name: 'RimWorld Core' }),
    mod('alpha.tools', 1, {
      assetPath: 'Mods/alpha.tools',
      activeFolders: ['1.6', '.'],
      warnings: [
        'unsupportedVersion: 1.6 not in supportedVersions',
        'loadFolders: unknown folder "Extra"',
      ],
    }),
    mod('beta.core', 2, { assetPath: 'Mods/beta.core' }),
    mod('ghost.mod', -1, { warnings: ['missing About.xml'] }),
  ])
})

afterAll(() => db.close())

describe('list-mods overview (default tier)', () => {
  test('one line per mod with loadOrder, packageId, name, source and warning count', () => {
    const text = listMods(db).content[0].text

    expect(text).toContain('Mods (3):')
    expect(text).toContain('[0] ludeon.rimworld — RimWorld Core (official)')
    expect(text).toContain('[1] alpha.tools — alpha.tools (mod) ⚠2')
    expect(text).toContain('[2] beta.core — beta.core (mod)')
    expect(text).not.toContain('ghost.mod')
  })

  test('omits folders=, assets= and warning bodies — the 40KB sources', () => {
    const text = listMods(db).content[0].text

    expect(text).not.toContain('folders=')
    expect(text).not.toContain('assets=')
    expect(text).not.toContain('unsupportedVersion')
    expect(text).not.toContain('loadFolders')
  })

  test('footer points at the detail tier', () => {
    expect(listMods(db).content[0].text).toContain(
      'Use detail:true (with page) for folders/assets/full warnings.',
    )
  })

  test('structured rows carry only the four overview fields', () => {
    const { structuredContent } = listMods(db)

    expect(structuredContent.total).toBe(3)
    for (const row of structuredContent.results) {
      expect(Object.keys(row).sort()).toEqual(['loadOrder', 'name', 'packageId', 'source'])
    }
  })

  test('source folds builtin to official and workshop to mod', () => {
    const results = listMods(db).structuredContent.results

    expect(results.find(r => r.packageId === 'ludeon.rimworld')!.source).toBe('official')
    expect(results.find(r => r.packageId === 'alpha.tools')!.source).toBe('mod')
  })

  test('mods outside the profile never surface', () => {
    const result = listMods(db)

    expect(result.structuredContent.results.map(r => r.packageId)).not.toContain('ghost.mod')
    expect(result.content[0].text).not.toContain('ghost.mod')
  })

  test('an empty profile returns empty structuredContent with guidance text', () => {
    const empty = new Database(':memory:')
    ensureSchema(empty)
    try {
      const result = listMods(empty)

      expect(result.structuredContent).toEqual({ total: 0, results: [] })
      expect(result.content[0].text).toContain('No mods found')
    } finally {
      empty.close()
    }
  })
})

describe('list-mods detail tier', () => {
  test('detail:true shows folders, assets and every warning for the page', () => {
    const result = listMods(db, { detail: true })
    const text = result.content[0].text

    expect(text).toContain('Mods (3):')
    expect(text).toContain('[1] alpha.tools — alpha.tools (mod) ⚠2')
    expect(text).toContain('  folders: 1.6, .')
    expect(text).toContain('  assets: Mods/alpha.tools')
    expect(text).toContain('  warnings:')
    expect(text).toContain('    - unsupportedVersion: 1.6 not in supportedVersions')
    expect(text).toContain('    - loadFolders: unknown folder "Extra"')
    expect(text).toContain('page 1/1')
  })

  test('detail structured rows carry all seven fields for the current page', () => {
    const { structuredContent } = listMods(db, { detail: true })

    expect(structuredContent.total).toBe(3)
    expect(structuredContent.results).toHaveLength(3)
    for (const row of structuredContent.results) {
      expect(Object.keys(row).sort()).toEqual([
        'activeFolders',
        'assetPath',
        'loadOrder',
        'name',
        'packageId',
        'source',
        'warnings',
      ])
    }
    const alpha = structuredContent.results.find(r => r.packageId === 'alpha.tools')!
    expect(alpha.activeFolders).toEqual(['1.6', '.'])
    expect(alpha.warnings).toEqual([
      'unsupportedVersion: 1.6 not in supportedVersions',
      'loadFolders: unknown folder "Extra"',
    ])
  })

  test('page out of range names the valid range', () => {
    const result = listMods(db, { detail: true, page: 2 })

    expect(result.content[0].text).toBe('page 2 out of range (1-1)')
    expect(result.structuredContent).toEqual({ total: 3, results: [] })
  })

  test('pages 20 mods per page by loadOrder', () => {
    const paged = new Database(':memory:')
    ensureSchema(paged)
    try {
      replaceMods(
        paged,
        Array.from({ length: 25 }, (_, i) => mod(`mod.${i}`, i)),
      )

      const first = listMods(paged, { detail: true })
      expect(first.content[0].text).toContain('page 1/2')
      expect(first.structuredContent.results).toHaveLength(20)
      expect(first.structuredContent.results[0]!.packageId).toBe('mod.0')
      expect(first.structuredContent.results[19]!.packageId).toBe('mod.19')

      const second = listMods(paged, { detail: true, page: 2 })
      expect(second.content[0].text).toContain('page 2/2')
      expect(second.structuredContent.results).toHaveLength(5)
      expect(second.structuredContent.results[0]!.packageId).toBe('mod.20')
      expect(second.structuredContent.total).toBe(25)

      const beyond = listMods(paged, { detail: true, page: 3 })
      expect(beyond.content[0].text).toBe('page 3 out of range (1-2)')
    } finally {
      paged.close()
    }
  })
})
