import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { getDefDetails } from '../../src/tools/get-def-details'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods } from '../../src/repositories/mods-repo'
import { replaceDefs } from '../../src/repositories/defs-repo'

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
  ])

  replaceDefs(db, [
    {
      defName: 'TestGun',
      defType: 'ThingDef',
      modId: 1,
      loadOrder: 0,
      label: null,
      filePath: null,
      mayRequire: null,
      rawPayload: JSON.stringify({
        defType: 'ThingDef',
        '@_ParentName': 'BaseGun',
        defName: 'TestGun',
      }),
      mergedPayload: JSON.stringify({
        defType: 'ThingDef',
        defName: 'TestGun',
        alwaysHaulable: true,
      }),
    },
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

describe('get-def-details', () => {
  test('returns an MCP error when the Def is missing', () => {
    const result = getDefDetails(db, 'MissingDef')

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not found')
  })

  test('renders raw and merged inheritance modes', () => {
    const raw = getDefDetails(db, 'TestGun', 'ThingDef', 'raw').content[0].text
    const merged = getDefDetails(db, 'TestGun', 'ThingDef').content[0].text

    expect(raw).toContain('ParentName="BaseGun"')
    expect(raw).not.toContain('<alwaysHaulable>true</alwaysHaulable>')
    expect(merged).toContain('<alwaysHaulable>true</alwaysHaulable>')
  })

  test('renders every Def when a name is shared across types', () => {
    const text = getDefDetails(db, 'SharedName').content[0].text

    expect(text).toContain('<BodyDef>')
    expect(text).toContain('<ThingDef>')
  })
})
