import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { searchHarmony } from '../../src/tools/search-harmony'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'
import { replaceHarmonyPatches } from '../../src/repositories/harmony-repo'

let db: Database

function mod(packageId: string, assetPath: string): ModInsertRow {
  return {
    packageId,
    name: packageId,
    source: 'workshop',
    assetPath,
    loadOrder: 1,
    inProfile: true,
    activeFolders: null,
    warnings: [],
    dataCategory: null,
  }
}

beforeAll(() => {
  db = new Database(':memory:')
  ensureSchema(db)
  replaceMods(db, [mod('mehni.pickupandhaul', 'Mods/mehni.pickupandhaul')])

  replaceHarmonyPatches(db, [
    {
      modId: 1,
      filePath: 'Mods/mehni.pickupandhaul/Source-decompiled/PickUpAndHaul.decompiled.cs',
      patchClass: 'HarmonyPatches',
      targetType: 'PawnUtility',
      targetMethod: 'CanPickUp',
      prefix: true,
      postfix: false,
      transpiler: false,
      finalizer: false,
    },
    {
      modId: 1,
      filePath: 'Mods/mehni.pickupandhaul/Source-decompiled/PickUpAndHaul.decompiled.cs',
      patchClass: 'HarmonyPatches',
      targetType: 'Pawn_InventoryTracker',
      targetMethod: 'Notify_ItemRemoved',
      prefix: false,
      postfix: true,
      transpiler: false,
      finalizer: false,
    },
    {
      // vanilla row: modId null renders as [vanilla]
      modId: null,
      filePath: 'Source/Boot.cs',
      patchClass: 'Boot',
      targetType: '*Assembly*',
      targetMethod: null,
      prefix: false,
      postfix: false,
      transpiler: false,
      finalizer: false,
    },
  ])
})

afterAll(() => {
  db.close()
})

describe('search_harmony', () => {
  test('filters by target type and renders patch class + kinds', () => {
    const result = searchHarmony(db, { targetType: 'PawnUtility' })
    const text = result.content[0].text

    expect(result.structuredContent.total).toBe(1)
    expect(text).toContain(
      '[mehni.pickupandhaul] HarmonyPatches -> PawnUtility.CanPickUp [prefix]',
    )
  })

  test('filters by method and packageId together', () => {
    const result = searchHarmony(db, {
      targetMethod: 'Notify_ItemRemoved',
      packageId: 'mehni.pickupandhaul',
    })
    expect(result.structuredContent.total).toBe(1)
    expect(result.structuredContent.results[0].postfix).toBe(true)
  })

  test('flags runtime-resolved rows with the read-the-source note', () => {
    const result = searchHarmony(db, {})
    expect(result.structuredContent.total).toBe(3)
    expect(result.content[0].text).toContain('[dynamic/*Assembly*')
    expect(result.content[0].text).toContain('[vanilla] Boot -> *Assembly*')
  })

  test('empty result carries the exact-match tip', () => {
    const result = searchHarmony(db, { targetType: 'NoSuchType' })
    expect(result.structuredContent.total).toBe(0)
    expect(result.content[0].text).toContain('No harmony patches found.')
    expect(result.content[0].text).toContain('Tip:')
  })
})
