import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { searchDefs, searchDefsImpl } from '../../src/tools/search-defs'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'
import { replaceDefs } from '../../src/repositories/defs-repo'

let db: Database

function mod(
  packageId: string,
  loadOrder: number,
  source: ModInsertRow['source'],
): ModInsertRow {
  return {
    packageId,
    name: packageId,
    author: null,
    source,
    rootPath: '',
    assetPath: '',
    loadOrder,
    inProfile: source === 'local' || source === 'workshop',
    playerActive: false,
    activeFolders: null,
    warnings: [],
    supportedVersions: ['1.6'],
    dependencies: [],
    dataCategory: null,
  }
}

beforeAll(() => {
  db = new Database(':memory:')
  ensureSchema(db)

  replaceMods(db, [
    mod('ludeon.rimworld', 0, 'builtin'),
    mod('mehni.pickupandhaul', 3, 'workshop'),
    mod('vanillaexpanded.framework', 2, 'workshop'),
  ])

  replaceDefs(db, [
    {
      defName: 'RelicInertCup',
      defType: 'ThingDef',
      modId: 1,
      loadOrder: 0,
      label: 'chalice',
      filePath: null,
      mayRequire: null,
      rawPayload: '{}',
      mergedPayload: '{}',
    },
    {
      defName: 'TestGun',
      defType: 'ThingDef',
      modId: 1,
      loadOrder: 0,
      label: 'test gun',
      filePath: null,
      mayRequire: null,
      rawPayload: '{}',
      mergedPayload: '{}',
    },
    {
      defName: 'TestGunJob',
      defType: 'JobDef',
      modId: 1,
      loadOrder: 0,
      label: 'test gun job',
      filePath: null,
      mayRequire: null,
      rawPayload: '{}',
      mergedPayload: '{}',
    },
    // same def in a community mod: overrides the vanilla one (higher loadOrder)
    {
      defName: 'TestGun',
      defType: 'ThingDef',
      modId: 2,
      loadOrder: 3,
      label: 'patched gun',
      filePath: null,
      mayRequire: null,
      rawPayload: '{}',
      mergedPayload: '{}',
    },
  ])
})

afterAll(() => db.close())

describe('search-defs', () => {
  test('matches labels case-insensitively and prefixes the owning mod', () => {
    const text = searchDefs(db, 'CHALICE').content[0].text

    expect(text).toContain('[ludeon.rimworld] [ThingDef] RelicInertCup')
    expect(text).toContain('(label: "chalice")')
  })

  test('filters results by Def type', () => {
    const result = searchDefsImpl(db, 'Gun', 'ThingDef', undefined, 10)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.defName).toBe('TestGun')
  })

  test('shows effective def with override count in mod-enabled profiles', () => {
    const text = searchDefs(db, 'TestGun', undefined, undefined, 10).content[0].text

    expect(text).toContain('[mehni.pickupandhaul] [ThingDef] TestGun (label: "patched gun") (+1 overridden)')
  })

  test('filters results by mod packageId', () => {
    const result = searchDefsImpl(db, 'Gun', undefined, 'mehni.pickupandhaul', 10)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.packageId).toBe('mehni.pickupandhaul')
  })

  test('reports truncated results', () => {
    const text = searchDefs(db, '', undefined, undefined, 1).content[0].text

    // 3 effective defs (TestGun collapses to its override)
    expect(text).toContain('[TRUNCATED] Showing 1/3 results.')
  })

  test('returns guidance when nothing matches', () => {
    const text = searchDefs(db, 'MissingDef').content[0].text

    expect(text).toBe('No results found. Try a shorter keyword.')
  })
})
