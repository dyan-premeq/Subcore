import { describe, expect, test } from 'bun:test'
import type { ModInfo } from '../../src/types'
import { resolveProfileOrder } from '../../src/utils/load-order'

const GAME_VERSION = '1.6.4871'

function mod(
  packageId: string,
  overrides: Partial<ModInfo> = {},
): ModInfo {
  return {
    packageId,
    name: packageId,
    source: 'local',
    rootPath: `/mods/${packageId}`,
    supportedVersions: ['1.6'],
    loadFolders: {},
    versionDirs: [],
    dependencies: [],
    loadAfter: [],
    loadBefore: [],
    incompatibleWith: [],
    warnings: [],
    dataCategory: undefined,
    ...overrides,
  }
}

const VANILLA = [
  mod('ludeon.rimworld', { source: 'builtin' }),
  mod('ludeon.rimworld.royalty', { source: 'dlc' }),
  mod('ludeon.rimworld.ideology', { source: 'dlc' }),
]

function ids(ordered: ModInfo[]): string[] {
  return ordered.map(mod => mod.packageId)
}

describe('load-order', () => {
  test('anchors Core at 0 and DLCs in official ProductPackageIDs order', () => {
    const result = resolveProfileOrder(VANILLA, { name: 't', base: 'all-dlc', mods: [], autoOrder: true }, { gameVersion: GAME_VERSION })
    expect(ids(result.ordered)).toEqual([
      'ludeon.rimworld',
      'ludeon.rimworld.royalty',
      'ludeon.rimworld.ideology',
    ])

    const coreOnly = resolveProfileOrder(VANILLA, { name: 't', base: 'core-only', mods: [], autoOrder: true }, { gameVersion: GAME_VERSION })
    expect(ids(coreOnly.ordered)).toEqual(['ludeon.rimworld'])
  })

  test('sorts a dependency chain: beta <- alpha <- gamma', () => {
    const mods = [
      ...VANILLA,
      mod('alpha.tools', { dependencies: [{ packageId: 'beta.core' }] }),
      mod('beta.core'),
      mod('gamma.conditional', { dependencies: [{ packageId: 'alpha.tools' }] }),
    ]
    const result = resolveProfileOrder(
      mods,
      { name: 't', base: 'all-dlc', mods: ['gamma.conditional', 'alpha.tools', 'beta.core'], autoOrder: true },
      { gameVersion: GAME_VERSION },
    )
    expect(ids(result.ordered)).toEqual([
      'ludeon.rimworld',
      'ludeon.rimworld.royalty',
      'ludeon.rimworld.ideology',
      'beta.core',
      'alpha.tools',
      'gamma.conditional',
    ])
    expect(result.issues).toEqual([])
  })

  test('respects loadAfter and loadBefore edges', () => {
    const mods = [
      ...VANILLA,
      mod('mod.a'),
      mod('mod.b', { loadAfter: ['mod.a'] }),
      mod('mod.c', { loadBefore: ['mod.a'] }),
    ]
    const result = resolveProfileOrder(
      mods,
      { name: 't', base: 'all-dlc', mods: ['mod.a', 'mod.b', 'mod.c'], autoOrder: true },
      { gameVersion: GAME_VERSION },
    )
    const order = ids(result.ordered)
    expect(order.indexOf('mod.c')).toBeLessThan(order.indexOf('mod.a'))
    expect(order.indexOf('mod.a')).toBeLessThan(order.indexOf('mod.b'))
  })

  test('breaks ties deterministically (diamond, lexicographic)', () => {
    const mods = [
      ...VANILLA,
      mod('mod.base'),
      mod('mod.zeta', { dependencies: [{ packageId: 'mod.base' }] }),
      mod('mod.alfa', { dependencies: [{ packageId: 'mod.base' }] }),
      mod('mod.top', {
        dependencies: [{ packageId: 'mod.zeta' }, { packageId: 'mod.alfa' }],
      }),
    ]
    const result = resolveProfileOrder(
      mods,
      { name: 't', base: 'all-dlc', mods: ['mod.top', 'mod.zeta', 'mod.alfa', 'mod.base'], autoOrder: true },
      { gameVersion: GAME_VERSION },
    )
    const order = ids(result.ordered)
    expect(order.slice(3)).toEqual(['mod.base', 'mod.alfa', 'mod.zeta', 'mod.top'])

    const again = resolveProfileOrder(
      mods,
      { name: 't', base: 'all-dlc', mods: ['mod.top', 'mod.zeta', 'mod.alfa', 'mod.base'], autoOrder: true },
      { gameVersion: GAME_VERSION },
    )
    expect(ids(again.ordered)).toEqual(order)
  })

  test('inlines dependency cycles with an issue instead of failing', () => {
    const mods = [
      ...VANILLA,
      mod('mod.x', { dependencies: [{ packageId: 'mod.y' }] }),
      mod('mod.y', { dependencies: [{ packageId: 'mod.x' }] }),
      mod('mod.after', { dependencies: [{ packageId: 'mod.x' }] }),
    ]
    const result = resolveProfileOrder(
      mods,
      { name: 't', base: 'all-dlc', mods: ['mod.x', 'mod.y', 'mod.after'], autoOrder: true },
      { gameVersion: GAME_VERSION },
    )
    expect(result.ordered).toHaveLength(6) // nothing dropped
    const cycleIssue = result.issues.find(issue => issue.kind === 'cycle')
    expect(cycleIssue?.detail).toContain('mod.x')
    expect(cycleIssue?.detail).toContain('mod.y')
    // cycle members stay before their dependent
    const order = ids(result.ordered)
    expect(order.indexOf('mod.x')).toBeLessThan(order.indexOf('mod.after'))
    expect(order.indexOf('mod.y')).toBeLessThan(order.indexOf('mod.after'))
  })

  test('reports missing dependencies and incompatible pairs without dropping mods', () => {
    const mods = [
      ...VANILLA,
      mod('mod.lonely', { dependencies: [{ packageId: 'ghost.mod' }] }),
      mod('mod.aaa', { incompatibleWith: ['mod.bbb'] }),
      mod('mod.bbb'),
    ]
    const result = resolveProfileOrder(
      mods,
      { name: 't', base: 'all-dlc', mods: ['mod.lonely', 'mod.aaa', 'mod.bbb'], autoOrder: true },
      { gameVersion: GAME_VERSION },
    )
    expect(ids(result.ordered)).toContain('mod.lonely')
    expect(result.issues.some(i => i.kind === 'missing-dependency')).toBe(true)
    expect(result.issues.some(i => i.kind === 'incompatible-with')).toBe(true)
  })

  test('excludes unknown packageIds and version-unsupported mods with issues', () => {
    const mods = [
      ...VANILLA,
      mod('mod.old', { supportedVersions: ['1.5'] }),
    ]
    const result = resolveProfileOrder(
      mods,
      { name: 't', base: 'all-dlc', mods: ['ghost.mod', 'mod.old'], autoOrder: true },
      { gameVersion: GAME_VERSION },
    )
    expect(ids(result.ordered)).not.toContain('ghost.mod')
    expect(ids(result.ordered)).not.toContain('mod.old')
    expect(result.issues.map(i => i.kind).sort()).toEqual(['not-found', 'version-unsupported'])
  })

  test('autoOrder=false keeps the declared order (Core still anchored)', () => {
    const mods = [
      ...VANILLA,
      mod('mod.a', { dependencies: [{ packageId: 'mod.b' }] }),
      mod('mod.b'),
    ]
    const result = resolveProfileOrder(
      mods,
      { name: 't', base: 'all-dlc', mods: ['mod.a', 'mod.b'], autoOrder: false },
      { gameVersion: GAME_VERSION },
    )
    // declared order kept even though it violates the dependency
    expect(ids(result.ordered)).toEqual([
      'ludeon.rimworld',
      'ludeon.rimworld.royalty',
      'ludeon.rimworld.ideology',
      'mod.a',
      'mod.b',
    ])
    expect(result.issues.some(i => i.kind === 'missing-dependency')).toBe(false)
  })
})
