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
    author: null,
    source: 'workshop',
    rootPath: '',
    assetPath: '',
    loadOrder,
    inProfile: loadOrder >= 0,
    playerActive: false,
    activeFolders: null,
    warnings: [],
    supportedVersions: ['1.6'],
    dependencies: [],
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
      playerActive: true,
      dependencies: [{ packageId: 'beta.core' }],
      warnings: ['unsupportedVersion: 1.6 not in supportedVersions'],
    }),
    mod('beta.core', 2, {
      assetPath: 'Mods/beta.core',
      playerActive: true,
    }),
    mod('ghost.mod', -1, { warnings: ['missing About.xml'] }),
  ])
})

afterAll(() => db.close())

describe('list-mods', () => {
  test('lists in-profile mods with load order and metadata, then metadata-only mods', () => {
    const text = listMods(db).content[0].text

    expect(text).toContain('Mods (3 in profile):')
    expect(text).toContain('[0] ludeon.rimworld RimWorld Core (builtin; in-profile')
    expect(text).toContain('[1] alpha.tools')
    expect(text).toContain('player-active')
    expect(text).toContain('Discovered but not in profile (1, metadata only):')
    // alpha depends on beta.core which IS indexed
    expect(text).toContain('deps: ok')
    expect(text).toContain('[-] ghost.mod')
    expect(text).toContain('warnings(1)')
  })

  test('inProfile=true hides metadata-only mods', () => {
    const text = listMods(db, { inProfile: true }).content[0].text
    expect(text).not.toContain('ghost.mod')
    expect(text).not.toContain('Discovered but not in profile')
  })

  test('playerActive=true is a diagnostic view', () => {
    const text = listMods(db, { playerActive: true }).content[0].text
    expect(text).toContain('alpha.tools')
    expect(text).toContain('beta.core')
    expect(text).not.toContain('ludeon.rimworld') // playerActive=false for base
  })


})
