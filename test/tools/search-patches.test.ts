import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { searchPatches } from '../../src/tools/search-patches'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'
import { replacePatchOps } from '../../src/repositories/patches-repo'

let db: Database

function mod(packageId: string, modId: number, loadOrder: number): ModInsertRow {
  return {
    packageId,
    name: packageId,
    source: loadOrder === 0 ? 'builtin' : 'workshop',
    assetPath: loadOrder === 0 ? '' : `Mods/${packageId}`,
    loadOrder,
    inProfile: true,
    activeFolders: null,
    warnings: [],
    dataCategory: null,
  }
}

beforeAll(() => {
  db = new Database(':memory:')
  ensureSchema(db)

  // modIds are explicit so the test data stays readable
  replaceMods(db, [mod('ludeon.rimworld', 1, 0), mod('beta.mod', 2, 1), mod('gamma.mod', 3, 2)])

  replacePatchOps(db, [
    {
      modId: 1,
      filePath: 'Core/Patches/A.xml',
      seq: 0,
      opClass: 'patchoperationadd',
      xpath: 'Defs/ThingDef[defName="Gun_A"]/comps',
      xpathNorm: "Defs/ThingDef[defName='Gun_A']/comps",
      targetDefs: ['Gun_A'],
      status: 'applied',
    },
    {
      modId: 2,
      filePath: 'Mods/beta.mod/Patches/B.xml',
      seq: 0,
      opClass: 'patchoperationreplace',
      xpath: 'Defs/ThingDef[defName="Gun_AB"]',
      xpathNorm: "Defs/ThingDef[defName='Gun_AB']",
      // prefix defName: must NOT match a search for Gun_A
      targetDefs: ['Gun_AB'],
      status: 'applied',
    },
    {
      modId: 2,
      filePath: 'Mods/beta.mod/Patches/B.xml',
      seq: 1,
      opClass: 'patchoperationfindmod',
      xpath: null,
      xpathNorm: null,
      targetDefs: [],
      status: 'applied',
    },
    {
      modId: 3,
      filePath: 'Mods/gamma.mod/Patches/C.xml',
      seq: 0,
      opClass: 'patchoperationadd',
      xpath: 'Defs/ThingDef[defName="Gun_A"]/statBases',
      xpathNorm: "Defs/ThingDef[defName='Gun_A']/statBases",
      targetDefs: ['Gun_A'],
      status: 'no-match',
    },
    {
      modId: 3,
      filePath: 'Mods/gamma.mod/Patches/C.xml',
      seq: 1,
      opClass: 'patchoperationadd',
      xpath: 'Defs/ThingDef[defName="GunXA"]',
      xpathNorm: "Defs/ThingDef[defName='GunXA']",
      // underscore-position difference: '_' as a LIKE wildcard would match X
      targetDefs: ['GunXA'],
      status: 'applied',
    },
  ])
})

afterAll(() => {
  db.close()
})

describe('search_patches', () => {
  test('finds ops by defName with exact element matching (no prefix false-positives)', () => {
    const { structuredContent } = searchPatches(db, { defName: 'Gun_A' })
    expect(structuredContent.total).toBe(2)
    expect(structuredContent.results.map(r => r.packageId).sort()).toEqual([
      'gamma.mod',
      'ludeon.rimworld',
    ])
  })

  test('underscore in defName matches literally, not as a LIKE single-char wildcard', () => {
    // 'Gun_A' must not match 'GunXA' — unescaped '_' is a LIKE wildcard for X
    const { structuredContent } = searchPatches(db, { defName: 'Gun_A' })
    expect(structuredContent.results.map(r => r.targetDefs)).toEqual([['Gun_A'], ['Gun_A']])
  })

  test('filters by packageId and opClass (case-insensitive)', () => {
    expect(searchPatches(db, { packageId: 'BETA.mod' }).structuredContent.total).toBe(2)
    expect(searchPatches(db, { packageId: 'beta.mod', opClass: 'PatchOperationReplace' }).structuredContent.total).toBe(1)
    expect(
      searchPatches(db, { packageId: 'beta.mod', opClass: 'PatchOperationReplace' }).structuredContent
        .results[0]!.targetDefs,
    ).toEqual(['Gun_AB'])
  })

  test('formats rows with [packageId] prefixes and status', () => {
    const result = searchPatches(db, { defName: 'Gun_AB' })
    expect(result.content[0]!.text).toContain('[beta.mod] Mods/beta.mod/Patches/B.xml #0')
    expect(result.content[0]!.text).toContain('patchoperationreplace (applied)')
    expect(result.content[0]!.text).toContain('→ Gun_AB')
  })

  test('empty result carries a defName-specific hint', () => {
    const result = searchPatches(db, { defName: 'Unknown' })
    expect(result.structuredContent.total).toBe(0)
    expect(result.content[0]!.text).toContain('No patch operations found')
    expect(result.content[0]!.text).toContain('--skip-patches')
  })

  test('null-xpath container ops are returned with nullable xpath', () => {
    const result = searchPatches(db, { opClass: 'patchoperationfindmod' })
    expect(result.structuredContent.results[0]!.xpath).toBeNull()
  })
})
