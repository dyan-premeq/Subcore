import type { Def } from '../../src/types'
import { describe, expect, test } from 'bun:test'
import {
  isMayRequireSatisfied,
  processDefs,
  type DefEntry,
} from '../../src/utils/def-resolver'

function entry(
  def: Def,
  modId = 1,
  loadOrder = 0,
  defType = 'ThingDef',
): DefEntry {
  return { def, defType, modId, loadOrder }
}

describe('def-resolver', () => {
  test('resolves multi-level inheritance and child overrides', () => {
    const defs: Def[] = [
      { '@_Name': 'GrandParent', label: 'base', a: 1 },
      { '@_Name': 'Parent', '@_ParentName': 'GrandParent', b: 2 },
      {
        defName: 'Child',
        '@_ParentName': 'Parent',
        label: 'child',
        c: 3,
      },
    ]

    expect(processDefs(defs.map(d => entry(d))).resolved[2]).toMatchObject({
      defName: 'Child',
      label: 'child',
      a: 1,
      b: 2,
      c: 3,
    })
  })

  test('appends inherited li lists', () => {
    const defs: Def[] = [
      { '@_Name': 'Base', list: [1, 2] },
      { defName: 'Child', '@_ParentName': 'Base', list: [3] },
    ]

    expect(processDefs(defs.map(d => entry(d))).resolved[1].list).toEqual([1, 2, 3])
  })

  test('replaces nodes marked Inherit=false and strips the marker', () => {
    const defs: Def[] = [
      { '@_Name': 'Base', data: { a: 1, b: 2 } },
      {
        defName: 'Child',
        '@_ParentName': 'Base',
        data: { '@_Inherit': 'False', c: 3 },
      },
    ]

    // game: parent children are discarded, the Inherit attr must not leak
    expect(processDefs(defs.map(d => entry(d))).resolved[1].data).toEqual({ c: 3 })
  })

  test('child attributes fully replace parent attributes', () => {
    const defs: Def[] = [
      {
        '@_Name': 'Base',
        '@_MayRequire': 'some.mod',
        '@_Abstract': 'True',
        label: 'parent label',
        hp: 1,
      },
      { defName: 'Child', '@_ParentName': 'Base', label: 'child label' },
    ]

    const resolved = processDefs(defs.map(d => entry(d))).resolved[1]!
    expect(resolved['@_MayRequire']).toBeUndefined()
    expect(resolved['@_Abstract']).toBeUndefined()
    expect(resolved.label).toBe('child label')
    expect(resolved.hp).toBe(1)
  })

  test('keeps inheritance machinery attrs out of merged payloads', () => {
    const defs: Def[] = [
      { '@_Name': 'Base', hp: 1 },
      { defName: 'Child', '@_Name': 'NamedChild', '@_ParentName': 'Base' },
    ]

    const resolved = processDefs(defs.map(d => entry(d))).resolved[1]!
    expect(resolved['@_Name']).toBeUndefined()
    expect(resolved['@_ParentName']).toBeUndefined()
  })

  test('an empty child element keeps the parent children', () => {
    const defs: Def[] = [
      { '@_Name': 'Base', comps: { li: [{ x: 1 }, { y: 2 }] } },
      { defName: 'Child', '@_ParentName': 'Base', comps: '' },
    ]

    expect(processDefs(defs.map(d => entry(d))).resolved[1].comps).toEqual({
      li: [{ x: 1 }, { y: 2 }],
    })
  })

  test('a child text value replaces all parent child nodes', () => {
    const defs: Def[] = [
      { '@_Name': 'Base', desc: { sub: 1 } },
      { defName: 'Child', '@_ParentName': 'Base', desc: { '#text': 'plain' } },
    ]

    expect(processDefs(defs.map(d => entry(d))).resolved[1].desc).toEqual({
      '#text': 'plain',
    })
  })

  // #region parent selection by load order (game GetBestParentFor)

  test('picks the same-@Name candidate with the highest loadOrder <= child', () => {
    const defs: DefEntry[] = [
      entry({ '@_Name': 'X', v: 'early' }, 1, 0),
      entry({ '@_Name': 'X', v: 'late' }, 2, 2),
      // child between both candidates: only the early parent is visible
      entry({ defName: 'Mid', '@_ParentName': 'X' }, 3, 1),
      // child after both: the later parent wins
      entry({ defName: 'Late', '@_ParentName': 'X' }, 3, 3),
    ]

    const resolved = processDefs(defs).resolved
    expect(resolved[2]!.v).toBe('early')
    expect(resolved[3]!.v).toBe('late')
  })

  test('rejects a duplicate @Name inside one mod (first wins)', () => {
    const defs: DefEntry[] = [
      entry({ '@_Name': 'X', v: 'first' }, 1, 0),
      entry({ '@_Name': 'X', v: 'second' }, 1, 0),
      entry({ defName: 'Child', '@_ParentName': 'X' }, 1, 0),
    ]

    const { resolved, nameRegistry, issues } = processDefs(defs)

    expect(resolved[2]!.v).toBe('first')
    expect(nameRegistry.filter(r => r.name === 'X')).toHaveLength(1)
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'duplicate-name', name: 'X' }),
    )
  })

  // #endregion

  // #region game tolerance: missing parents / cycles never crash the build

  test('treats a def with a missing parent as a root node', () => {
    const defs: Def[] = [
      { defName: 'Orphan', '@_ParentName': 'GhostBase', label: 'orphan' },
    ]

    const { resolved, issues } = processDefs(defs.map(d => entry(d)))

    expect(resolved[0]).toMatchObject({ defName: 'Orphan', label: 'orphan' })
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'missing-parent', name: 'GhostBase' }),
    )
  })

  test('a parent defined only in a later mod is missing for earlier children', () => {
    const defs = [
      entry({ defName: 'Early', '@_ParentName': 'X' }, 1, 0),
      entry({ '@_Name': 'X', v: 1 }, 2, 1),
    ]

    const { resolved, issues } = processDefs(defs)
    expect(resolved[0]).toMatchObject({ defName: 'Early' })
    expect(resolved[0]!.v).toBeUndefined()
    expect(issues.some(i => i.kind === 'missing-parent')).toBe(true)
  })

  test('cycle members stay raw and defs above the cycle merge with the raw parent', () => {
    const defs: DefEntry[] = [
      entry({ '@_Name': 'A', '@_ParentName': 'B', a: 1 }, 1, 0),
      entry({ '@_Name': 'B', '@_ParentName': 'A', b: 1 }, 1, 0),
      entry({ defName: 'AboveCycle', '@_ParentName': 'B', c: 1 }, 1, 0),
      entry({ defName: 'Unrelated', hp: 5 }, 1, 0),
    ]

    const { resolved, issues } = processDefs(defs)

    // cycle members: raw, no cross-contamination
    expect(resolved[0]).toMatchObject({ a: 1 })
    expect(resolved[0]!.b).toBeUndefined()
    expect(resolved[1]).toMatchObject({ b: 1 })
    expect(resolved[1]!.a).toBeUndefined()
    // above the cycle: merged with the raw parent
    expect(resolved[2]).toMatchObject({ b: 1, c: 1 })
    expect(resolved[3]).toMatchObject({ hp: 5 })
    expect(issues.some(i => i.kind === 'cycle')).toBe(true)
  })

  // #endregion

  test('registers named defs (abstract or not) for def_names', () => {
    const defs: DefEntry[] = [
      entry({ '@_Name': 'AbstractBase', '@_Abstract': 'True' }, 1, 0),
      entry({ defName: 'ConcreteGun', '@_Name': 'ConcreteGun' }, 2, 1, 'ThingDef'),
    ]

    const { nameRegistry } = processDefs(defs)

    expect(nameRegistry).toEqual([
      {
        name: 'AbstractBase',
        modId: 1,
        loadOrder: 0,
        defType: 'ThingDef',
        defName: null,
      },
      {
        name: 'ConcreteGun',
        modId: 2,
        loadOrder: 1,
        defType: 'ThingDef',
        defName: 'ConcreteGun',
      },
    ])
  })
})

describe('isMayRequireSatisfied', () => {
  const active = new Set(['ludeon.rimworld', 'mehni.pickupandhaul'])

  test('MayRequire: all listed packageIds must be active', () => {
    expect(isMayRequireSatisfied('ludeon.rimworld', undefined, active)).toBe(true)
    expect(
      isMayRequireSatisfied('ludeon.rimworld, mehni.pickupandhaul', undefined, active),
    ).toBe(true)
    expect(
      isMayRequireSatisfied('ludeon.rimworld, some.other.mod', undefined, active),
    ).toBe(false)
  })

  test('MayRequireAnyOf: at least one must be active', () => {
    expect(isMayRequireSatisfied(undefined, 'some.other.mod, oskar.dlc', active)).toBe(
      false,
    )
    expect(isMayRequireSatisfied(undefined, 'some.other.mod, ludeon.rimworld', active)).toBe(
      true,
    )
  })

  test('matching is case-insensitive and ignores |postfix suffixes', () => {
    expect(isMayRequireSatisfied('Mehni.PickUpAndHaul', undefined, active)).toBe(true)
    expect(isMayRequireSatisfied('mehni.pickupandhaul|steam', undefined, active)).toBe(
      true,
    )
    expect(
      isMayRequireSatisfied(undefined, 'Ludeon.RimWorld|vanilla', active),
    ).toBe(true)
  })

  test('no condition means satisfied', () => {
    expect(isMayRequireSatisfied(undefined, undefined, active)).toBe(true)
  })
})
