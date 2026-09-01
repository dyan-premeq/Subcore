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
      warnings: ['unsupportedVersion: 1.6 not in supportedVersions'],
    }),
    mod('beta.core', 2, { assetPath: 'Mods/beta.core' }),
    mod('ghost.mod', -1, { warnings: ['missing About.xml'] }),
  ])
})

afterAll(() => db.close())

describe('list-mods', () => {
  test('lists in-profile mods in load order, omitting the rest', () => {
    const text = listMods(db).content[0].text

    expect(text).toContain('Mods (3):')
    expect(text).toContain('[0] ludeon.rimworld RimWorld Core (official)')
    expect(text).toContain('[1] alpha.tools alpha.tools (mod)')
    expect(text).toContain('folders=1.6,.')
    expect(text).toContain(
      'warnings(1): unsupportedVersion: 1.6 not in supportedVersions',
    )
    expect(text).toContain('[2] beta.core')
    expect(text).not.toContain('ghost.mod')
  })

  test('structured rows carry exactly the seven output fields', () => {
    const { structuredContent } = listMods(db)

    expect(structuredContent.total).toBe(3)
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
  })

  test('source folds builtin to official and workshop to mod', () => {
    const results = listMods(db).structuredContent.results

    expect(results.find(r => r.packageId === 'ludeon.rimworld')!.source).toBe(
      'official',
    )
    expect(results.find(r => r.packageId === 'alpha.tools')!.source).toBe('mod')
  })

  test('activeFolders and warnings are arrays, not JSON strings', () => {
    const alpha = listMods(db).structuredContent.results.find(
      r => r.packageId === 'alpha.tools',
    )!

    expect(Array.isArray(alpha.activeFolders)).toBe(true)
    expect(alpha.activeFolders).toEqual(['1.6', '.'])
    expect(Array.isArray(alpha.warnings)).toBe(true)
    expect(alpha.warnings).toEqual([
      'unsupportedVersion: 1.6 not in supportedVersions',
    ])
  })

  test('mods outside the profile never surface', () => {
    const result = listMods(db)

    expect(result.structuredContent.results.map(r => r.packageId)).not.toContain(
      'ghost.mod',
    )
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
