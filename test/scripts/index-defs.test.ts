import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { write } from 'bun'
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuildDefsIndex } from '../../src/scripts/index-defs'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'
import { searchDefsEffective, getDefDetailsRows } from '../../src/repositories/defs-repo'
import { rmTemp } from '../helpers/fs'

let tempRoot: string

function mod(packageId: string, loadOrder: number, dataCategory: string | null = null): ModInsertRow {
  return {
    packageId,
    name: packageId,
    author: null,
    source: loadOrder === 0 ? 'builtin' : 'workshop',
    rootPath: '',
    assetPath: loadOrder === 0 ? '' : `Mods/${packageId}`,
    loadOrder,
    inProfile: true,
    playerActive: false,
    activeFolders: null,
    warnings: [],
    supportedVersions: ['1.6'],
    dependencies: [],
    dataCategory,
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'rimsage-index-defs-'))

  // vanilla defs: Core category with base + vanilla version of OverrideMe
  const defsPath = join(tempRoot, 'Defs/Core')
  await mkdir(defsPath, { recursive: true })
  await write(
    join(defsPath, 'Things.xml'),
    `
      <Defs>
        <ThingDef Name="GunBase" Abstract="True">
          <label>gun base</label>
          <statBases><MaxHitPoints>100</MaxHitPoints></statBases>
        </ThingDef>
        <ThingDef ParentName="GunBase">
          <defName>OverrideMe</defName>
          <label>vanilla gun</label>
        </ThingDef>
        <ThingDef>
          <defName>VanillaOnly</defName>
          <label>vanilla only</label>
        </ThingDef>
        <ThingDef Name="SharedBase" Abstract="True">
          <label>core shared base</label>
        </ThingDef>
      </Defs>
    `,
  )

  // mod dist: beta.mod/1.6/Defs overrides OverrideMe, adds ModOnly
  const modDefs = join(tempRoot, 'Mods/beta.mod/1.6/Defs')
  await mkdir(modDefs, { recursive: true })
  await write(
    join(modDefs, 'PatchDefs.xml'),
    `
      <Defs>
        <ThingDef ParentName="GunBase">
          <defName>OverrideMe</defName>
          <label>beta gun (overridden)</label>
        </ThingDef>
        <ThingDef MayRequire="some.mod">
          <defName>ModOnly</defName>
          <label>inactive in the profile: must be skipped</label>
        </ThingDef>
        <ThingDef MayRequire="beta.mod">
          <defName>ModConditional</defName>
          <label>active in the profile: indexed</label>
        </ThingDef>
        <ThingDef ParentName="GhostBase">
          <defName>Orphan</defName>
          <label>missing parent must not crash the build</label>
        </ThingDef>
        <ThingDef Name="SharedBase" Abstract="True">
          <label>beta shared base</label>
        </ThingDef>
      </Defs>
    `,
  )
  // duplicate defName+defType within the same mod: ZDupes.xml sorts after
  // PatchDefs.xml, so its OverrideMe must be dropped (first file wins)
  await write(
    join(tempRoot, 'Mods/beta.mod/1.6/Defs/ZDupes.xml'),
    `
      <Defs>
        <ThingDef ParentName="GunBase">
          <defName>OverrideMe</defName>
          <label>dupe gun (must be dropped)</label>
        </ThingDef>
        <ThingDef>
          <defName>UniqueFromDupes</defName>
          <label>unique</label>
        </ThingDef>
      </Defs>
    `,
  )
  // shadowed file: root Defs with the same relative path must be skipped
  await mkdir(join(tempRoot, 'Mods/beta.mod/Defs'), { recursive: true })
  await write(
    join(tempRoot, 'Mods/beta.mod/Defs/PatchDefs.xml'),
    `
      <Defs>
        <ThingDef>
          <defName>ShadowedDef</defName>
          <label>should not be indexed</label>
        </ThingDef>
      </Defs>
    `,
  )

  // mod dir absent from the manifest: the manifest is the single source of
  // truth for the effective file set, so the whole dir must be skipped
  await mkdir(join(tempRoot, 'Mods/ghost.mod/Defs'), { recursive: true })
  await write(
    join(tempRoot, 'Mods/ghost.mod/Defs/Ghost.xml'),
    `
      <Defs>
        <ThingDef>
          <defName>GhostDef</defName>
          <label>must not be indexed</label>
        </ThingDef>
      </Defs>
    `,
  )

  // manifest with effective sets (shadowing resolved)
  await write(
    join(tempRoot, 'mods-manifest.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      gameVersion: '1.6.4871',
      profile: { name: 't', base: 'all-dlc', mods: ['beta.mod'], autoOrder: true },
      playerActivePackageIds: null,
      mods: [
        {
          packageId: 'beta.mod',
          name: 'beta',
          source: 'workshop',
          rootPath: '/mods/beta',
          assetPath: 'Mods/beta.mod',
          loadOrder: 1,
          inProfile: true,
          playerActive: false,
          supportedVersions: ['1.6'],
          loadFolders: {},
          versionDirs: [],
          dependencies: [],
          loadAfter: [],
          loadBefore: [],
          incompatibleWith: [],
          warnings: [],
          activeFolders: ['1.6'],
          effectiveFiles: ['1.6/Defs/PatchDefs.xml', '1.6/Defs/ZDupes.xml'],
          shadowedFiles: ['Defs/PatchDefs.xml'],
          issues: [],
        },
      ],
      discoveredNotInProfile: [],
    }),
  )

  // mods table (index-defs resolves modIds from it)
  const dbPath = join(tempRoot, 'index.db')
  const db = new Database(dbPath)
  ensureSchema(db)
  replaceMods(db, [mod('ludeon.rimworld', 0, 'Core'), mod('beta.mod', 1)])
  db.close()

  await rebuildDefsIndex(dbPath, join(tempRoot, 'Defs'), join(tempRoot, 'Mods'), join(tempRoot, 'mods-manifest.json'))
})

afterAll(async () => {
  await rmTemp(tempRoot)
})

describe('index-defs', () => {
  test('fails loudly when the mods table is empty (run index:mods first)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'rimsage-index-defs-empty-'))
    try {
      const dbPath = join(empty, 'index.db')
      const db = new Database(dbPath)
      ensureSchema(db)
      db.close()

      expect(rebuildDefsIndex(dbPath, join(empty, 'Defs'))).rejects.toThrow('index:mods')
    } finally {
      await rmTemp(empty)
    }
  })

  test('builds raw and merged payloads for inherited defs', async () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const rows = db
        .query<{ rawPayload: string; mergedPayload: string }, { $name: string }>(
          'SELECT rawPayload, mergedPayload FROM defs WHERE defName = $name',
        )
        .all({ $name: 'OverrideMe' })

      // both versions kept; the vanilla row's raw payload stays as authored
      const vanilla = JSON.parse(rows.find(r => !r.mergedPayload.includes('beta gun'))!.rawPayload)
      expect(vanilla.statBases).toBeUndefined()

      // merged inheritance resolved through the abstract parent
      const merged = getDefDetailsRows(db, 'OverrideMe', 'ThingDef', { view: 'merged' })
      expect(JSON.parse(merged[0]!.payload).statBases.MaxHitPoints).toBe(100)
    } finally {
      db.close()
    }
  })

  test('keeps both versions of an overridden def (no INSERT OR REPLACE)', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const rows = db
        .query<
          { defName: string; modId: number; loadOrder: number },
          { $name: string }
        >(
          'SELECT defName, modId, loadOrder FROM defs WHERE defName = $name ORDER BY loadOrder',
        )
        .all({ $name: 'OverrideMe' })
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ modId: 1, loadOrder: 0 })
      expect(rows[1]).toMatchObject({ modId: 2, loadOrder: 1 })
    } finally {
      db.close()
    }
  })

  test('same-mod duplicate def keeps the first file (game AddAllInMods)', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const dupes = db
        .query<{ filePath: string; label: string | null }, { $name: string }>(
          'SELECT filePath, label FROM defs WHERE defName = $name AND modId = 2',
        )
        .all({ $name: 'OverrideMe' })
      // PatchDefs.xml < ZDupes.xml in byte order -> its row is kept
      expect(dupes).toHaveLength(1)
      expect(dupes[0]!.filePath).toBe('Mods/beta.mod/1.6/Defs/PatchDefs.xml')

      // the rest of ZDupes.xml is still indexed
      const unique = db
        .query<{ filePath: string }, { $name: string }>(
          'SELECT filePath FROM defs WHERE defName = $name',
        )
        .all({ $name: 'UniqueFromDupes' })
      expect(unique).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  test('effective search returns the highest loadOrder row with override count', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const rows = searchDefsEffective(db, 'OverrideMe', undefined, undefined, 10)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.packageId).toBe('beta.mod')
      expect(rows[0]!.versions).toBe(2)
    } finally {
      db.close()
    }
  })

  test('indexes only effective files, with dist-relative paths', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const shadowed = db
        .query<{ defName: string }, { $name: string }>(
          'SELECT defName FROM defs WHERE defName = $name',
        )
        .all({ $name: 'ShadowedDef' })
      expect(shadowed).toHaveLength(0) // root Defs copy was shadowed by 1.6/

      const row = db
        .query<{ filePath: string }, { $name: string }>(
          'SELECT filePath FROM defs WHERE defName = $name',
        )
        .get({ $name: 'ModConditional' })
      expect(row?.filePath).toBe('Mods/beta.mod/1.6/Defs/PatchDefs.xml')
    } finally {
      db.close()
    }
  })

  test('skips defs whose MayRequire is unsatisfied in the profile (game: not loaded)', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const skipped = db
        .query<{ defName: string }, { $name: string }>(
          'SELECT defName FROM defs WHERE defName = $name',
        )
        .all({ $name: 'ModOnly' })
      expect(skipped).toHaveLength(0) // some.mod is not in the profile
    } finally {
      db.close()
    }
  })

  test('missing-parent defs index as roots instead of crashing the build', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const rows = db
        .query<{ mergedPayload: string }, { $name: string }>(
          'SELECT mergedPayload FROM defs WHERE defName = $name',
        )
        .all({ $name: 'Orphan' })
      expect(rows).toHaveLength(1)
      const merged = JSON.parse(rows[0]!.mergedPayload)
      expect(merged.label).toBe('missing parent must not crash the build')
      expect(merged['@_ParentName']).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('populates def_names with the @Name registry', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const rows = db
        .query<
          { name: string; modId: number; loadOrder: number; defType: string; defName: string | null },
          { $name: string }
        >('SELECT * FROM def_names WHERE name = $name')
        .all({ $name: 'GunBase' })
      expect(rows).toEqual([
        { name: 'GunBase', modId: 1, loadOrder: 0, defType: 'ThingDef', defName: null },
      ])
    } finally {
      db.close()
    }
  })

  test('def_names keeps one row per (name, mod) registration across mods', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const rows = db
        .query<
          { name: string; modId: number; loadOrder: number },
          { $name: string }
        >(
          'SELECT name, modId, loadOrder FROM def_names WHERE name = $name ORDER BY loadOrder',
        )
        .all({ $name: 'SharedBase' })
      expect(rows).toEqual([
        { name: 'SharedBase', modId: 1, loadOrder: 0 },
        { name: 'SharedBase', modId: 2, loadOrder: 1 },
      ])
    } finally {
      db.close()
    }
  })

  test('skips dist mod dirs with no manifest entry (manifest is the source of truth)', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const rows = db
        .query<{ defName: string }, { $name: string }>(
          'SELECT defName FROM defs WHERE defName = $name',
        )
        .all({ $name: 'GhostDef' })
      expect(rows).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  test('merged inheritance works across the load-order-sorted corpus', () => {
    const db = new Database(join(tempRoot, 'index.db'), { readonly: true })
    try {
      const rows = getDefDetailsRows(db, 'OverrideMe', 'ThingDef', { view: 'merged' })
      expect(rows).toHaveLength(1)
      const merged = JSON.parse(rows[0]!.payload)
      // statBases inherited from the abstract parent defined in Core
      expect(merged.statBases.MaxHitPoints).toBe(100)
      expect(merged.label).toBe('beta gun (overridden)')
    } finally {
      db.close()
    }
  })
})
