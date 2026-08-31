import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { getDefDetails } from '../../src/tools/get-def-details'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods } from '../../src/repositories/mods-repo'
import { replaceDefs } from '../../src/repositories/defs-repo'
import { replacePatchedDefs } from '../../src/repositories/patches-repo'

let db: Database

beforeAll(() => {
  db = new Database(':memory:')
  ensureSchema(db)

  replaceMods(db, [
    {
      packageId: 'ludeon.rimworld',
      name: 'Core',
      author: null,
      source: 'builtin',
      rootPath: '',
      assetPath: '',
      loadOrder: 0,
      inProfile: true,
      playerActive: false,
      activeFolders: null,
      warnings: [],
      supportedVersions: [],
      dependencies: [],
      dataCategory: null,
    },
    {
      packageId: 'beta.mod',
      name: 'Beta',
      author: null,
      source: 'workshop',
      rootPath: '',
      assetPath: 'Mods/beta.mod',
      loadOrder: 2,
      inProfile: true,
      playerActive: false,
      activeFolders: null,
      warnings: [],
      supportedVersions: [],
      dependencies: [],
      dataCategory: null,
    },
  ])

  const defRow = (modId: number, loadOrder: number, label: string) => ({
    defName: 'TestGun',
    defType: 'ThingDef',
    modId,
    loadOrder,
    label: null,
    filePath: null,
    mayRequire: null,
    rawPayload: JSON.stringify({
      defType: 'ThingDef',
      '@_ParentName': 'BaseGun',
      defName: 'TestGun',
      label,
    }),
    mergedPayload: JSON.stringify({
      defType: 'ThingDef',
      defName: 'TestGun',
      label,
      alwaysHaulable: true,
    }),
  })

  replaceDefs(db, [
    defRow(1, 0, 'vanilla gun'),
    defRow(2, 2, 'beta gun'),
    ...['BodyDef', 'ThingDef'].map(defType => ({
      defName: 'SharedName',
      defType,
      modId: 1,
      loadOrder: 0,
      label: null,
      filePath: null,
      mayRequire: null,
      rawPayload: JSON.stringify({ defType, defName: 'SharedName' }),
      mergedPayload: JSON.stringify({ defType, defName: 'SharedName' }),
    })),
  ])
})

afterAll(() => db.close())

describe('get-def-details: view=patched', () => {
  test('renders the patched payload with its Patched by line', () => {
    replacePatchedDefs(db, [
      {
        defName: 'TestGun',
        defType: 'ThingDef',
        payload: JSON.stringify({
          defType: 'ThingDef',
          defName: 'TestGun',
          label: 'patched gun',
          comps: { li: [{ compClass: 'X' }] },
        }),
        changedBy: [2],
      },
    ])

    const result = getDefDetails(db, 'TestGun', 'ThingDef', { view: 'patched' })
    const text = result.content[0].text as string

    expect(text).toContain('Lineage: defined by ludeon.rimworld → effective: beta.mod')
    expect(text).toContain('Patched by: beta.mod')
    expect(text).toContain('<label>patched gun</label>')
    expect(text).toContain('<compClass>X</compClass>')

    expect(result.structuredContent!.defs[0]).toMatchObject({
      packageId: 'beta.mod',
      patchedBy: ['beta.mod'],
    })
  })

  test('falls back to the merged view with an explanation when no patched row exists', () => {
    const result = getDefDetails(db, 'SharedName', 'BodyDef', { view: 'patched' })
    const text = result.content[0].text as string

    expect(text).toContain('Patched view has no row')
    expect(text).toContain('showing the merged view instead')
    // merged payload still rendered
    expect(text).toContain('<defName>SharedName</defName>')
  })

  test('unknown defs in patched view still error out', () => {
    const result = getDefDetails(db, 'MissingDef', 'ThingDef', { view: 'patched' })
    expect(result.isError).toBe(true)
  })
})

describe('get-def-details', () => {
  test('returns an MCP error when the Def is missing', () => {
    const result = getDefDetails(db, 'MissingDef')

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not found')
  })

  test('renders raw and merged views', () => {
    const raw = getDefDetails(db, 'TestGun', 'ThingDef', { view: 'raw' }).content[0]
      .text as string
    const merged = getDefDetails(db, 'TestGun', 'ThingDef').content[0].text as string

    expect(raw).toContain('ParentName="BaseGun"')
    expect(raw).not.toContain('<alwaysHaulable>true</alwaysHaulable>')
    expect(merged).toContain('<alwaysHaulable>true</alwaysHaulable>')
  })

  test('renders every Def when a name is shared across types', () => {
    const text = getDefDetails(db, 'SharedName').content[0].text as string

    expect(text).toContain('<BodyDef>')
    expect(text).toContain('<ThingDef>')
  })

  test('shows the override lineage for the effective version', () => {
    const text = getDefDetails(db, 'TestGun', 'ThingDef').content[0].text as string

    expect(text).toContain(
      'Lineage: defined by ludeon.rimworld → effective: beta.mod',
    )
    expect(text).toContain('<label>beta gun</label>')
  })

  test('states a single-source lineage without overrides', () => {
    const text = getDefDetails(db, 'SharedName', 'BodyDef').content[0].text as string

    expect(text).toContain('Lineage: defined by ludeon.rimworld (effective)')
  })

  test('dup=all lists every mod version along the chain', () => {
    const text = getDefDetails(db, 'TestGun', 'ThingDef', { dup: 'all' }).content[0]
      .text as string

    expect(text).toContain('--- [ludeon.rimworld] (loadOrder 0) ---')
    expect(text).toContain('<label>vanilla gun</label>')
    expect(text).toContain('--- [beta.mod] (loadOrder 2, effective) ---')
    expect(text).toContain('<label>beta gun</label>')
  })

  test('mod filter narrows to one defining mod but keeps the global lineage', () => {
    const text = getDefDetails(db, 'TestGun', 'ThingDef', {
      dup: 'all',
      mod: 'ludeon.rimworld',
    }).content[0].text as string

    expect(text).toContain('<label>vanilla gun</label>')
    expect(text).not.toContain('beta gun')
    // lineage is inherently global: full chain + explicit note
    expect(text).toContain(
      'defined by ludeon.rimworld \u2192 effective: beta.mod',
    )
    expect(text).toContain('full global override chain')
  })

  test('returns structuredContent alongside the text rendering', () => {
    const result = getDefDetails(db, 'TestGun', 'ThingDef', { dup: 'all' })

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({
      lineage: [
        { packageId: 'ludeon.rimworld', loadOrder: 0 },
        { packageId: 'beta.mod', loadOrder: 2 },
      ],
      defs: [
        {
          defType: 'ThingDef',
          packageId: 'ludeon.rimworld',
          loadOrder: 0,
          filePath: null,
          xml: expect.stringContaining('<label>vanilla gun</label>'),
        },
        {
          defType: 'ThingDef',
          packageId: 'beta.mod',
          loadOrder: 2,
          filePath: null,
          xml: expect.stringContaining('<label>beta gun</label>'),
        },
      ],
    })
  })
})
