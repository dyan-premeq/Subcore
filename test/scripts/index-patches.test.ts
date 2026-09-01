import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { write } from 'bun'
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuildPatchesIndex } from '../../src/scripts/index-patches'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'
import {
  countPatchOpsByStatus,
  getPatchedDefs,
  searchPatchOps,
} from '../../src/repositories/patches-repo'
import { rmTemp } from '../helpers/fs'

let tempRoot: string
let dbPath: string

function mod(packageId: string, loadOrder: number, name: string | null = null): ModInsertRow {
  return {
    packageId,
    name,
    source: loadOrder === 0 ? 'builtin' : 'workshop',
    assetPath: loadOrder === 0 ? '' : `Mods/${packageId}`,
    loadOrder,
    inProfile: true,
    activeFolders: null,
    warnings: [],
    dataCategory: loadOrder === 0 ? 'Core' : null,
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'rimsage-index-patches-'))
  dbPath = join(tempRoot, 'index.db')

  // vanilla: Core defs + a Core patch (DLC ship patches too)
  const defsDir = join(tempRoot, 'defs/Core')
  const patchesDir = join(tempRoot, 'patches/Core')
  await mkdir(defsDir, { recursive: true })
  await mkdir(patchesDir, { recursive: true })

  await write(
    join(defsDir, 'Things.xml'),
    `
    <Defs>
      <ThingDef Name="GunBase" Abstract="True">
        <statBases><MaxHitPoints>100</MaxHitPoints></statBases>
      </ThingDef>
      <ThingDef ParentName="GunBase">
        <defName>Revolver</defName>
        <label>revolver</label>
      </ThingDef>
      <ThingDef>
        <defName>Pawn</defName>
        <comps><li><compClass>OldComp</compClass></li></comps>
      </ThingDef>
    </Defs>
    `,
  )
  // vanilla patch patches an abstract def: the child's patched view must
  // inherit the patched content (inheritance runs AFTER patches, §4.1)
  await write(
    join(patchesDir, 'CorePatch.xml'),
    `
    <Patch>
      <Operation Class="PatchOperationAdd">
        <xpath>Defs/ThingDef[@Name="GunBase"]</xpath>
        <value><thingClass>PatchedClass</thingClass></value>
      </Operation>
    </Patch>
    `,
  )

  // mod: root-level Patches folder (legacy layout, no version folder)
  const modPatches = join(tempRoot, 'mods/beta.mod/Patches')
  const modDefs = join(tempRoot, 'mods/beta.mod/Defs')
  await mkdir(modPatches, { recursive: true })
  await mkdir(modDefs, { recursive: true })

  await write(
    join(modPatches, 'PatchMain.xml'),
    `
    <Patch>
      <Operation Class="PatchOperationreplace">
        <xpath>Defs/ThingDef[defName="Pawn"]/comps</xpath>
        <value>
          <comps>
            <li><compClass>NewComp</compClass></li>
            <li><compClass>AnotherComp</compClass></li>
          </comps>
        </value>
      </Operation>
      <Operation Class="PatchOperationAdd">
        <xpath>/Defs</xpath>
        <value><RecipeDef><defName>PatchRecipe</defName><label>patch-made</label></RecipeDef></value>
      </Operation>
      <Operation Class="PatchOperationTest">
        <xpath>Defs/ThingDef[defName="DoesNotExist"]</xpath>
      </Operation>
    </Patch>
    `,
  )
  // same-mod duplicate defName: first file wins (game DefDatabase semantics)
  await write(
    join(modDefs, 'Dupes.xml'),
    `
    <Defs>
      <ThingDef><defName>ModThing</defName><label>first</label></ThingDef>
      <ThingDef MayRequire="not.active.mod"><defName>MayRequireGated</defName></ThingDef>
    </Defs>
    `,
  )
  await write(
    join(modDefs, 'ZDupes.xml'),
    `
    <Defs><ThingDef><defName>ModThing</defName><label>second (dropped)</label></ThingDef></Defs>
    `,
  )

  // manifest: mod root as the only load folder, effective files in order
  await write(
    join(tempRoot, 'manifest.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      gameVersion: '1.6.4871',
      profile: { name: 'test', base: 'all-dlc', mods: ['beta.mod'], autoOrder: true },
      mods: [
        {
          packageId: 'ludeon.rimworld',
          name: 'Core',
          source: 'builtin',
          rootPath: '',
          supportedVersions: ['1.6'],
          loadFolders: {},
          versionDirs: [],
          dependencies: [],
          loadAfter: [],
          loadBefore: [],
          incompatibleWith: [],
          warnings: [],
          loadOrder: 0,
          inProfile: true,
          assetPath: '',
          activeFolders: ['.'],
          effectiveFiles: [],
          shadowedFiles: [],
          issues: [],
        },
        {
          packageId: 'beta.mod',
          name: 'Beta Mod',
          source: 'workshop',
          rootPath: '',
          supportedVersions: ['1.6'],
          loadFolders: {},
          versionDirs: [],
          dependencies: [],
          loadAfter: [],
          loadBefore: [],
          incompatibleWith: [],
          warnings: [],
          loadOrder: 1,
          inProfile: true,
          assetPath: 'Mods/beta.mod',
          activeFolders: ['.'],
          effectiveFiles: ['Defs/Dupes.xml', 'Defs/ZDupes.xml', 'Patches/PatchMain.xml'],
          shadowedFiles: [],
          issues: [],
        },
      ],
      discoveredNotInProfile: [],
    }),
  )

  const db = new Database(dbPath)
  ensureSchema(db)
  replaceMods(db, [mod('ludeon.rimworld', 0, 'Core'), mod('beta.mod', 1, 'Beta Mod')])
  db.close()

  await rebuildPatchesIndex(
    dbPath,
    {},
    join(tempRoot, 'defs'),
    join(tempRoot, 'patches'),
    join(tempRoot, 'mods'),
    join(tempRoot, 'manifest.json'),
  )
})

afterAll(async () => {
  await rmTemp(tempRoot)
})

describe('index-patches (end to end)', () => {
  test('writes patch_ops rows with targetDefs backfilled', () => {
    const db = new Database(dbPath, { readonly: true })
    const rows = searchPatchOps(db, { defName: 'Pawn' })
    db.close()

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.packageId).toBe('beta.mod')
    expect(row.opClass).toBe('patchoperationreplace')
    expect(JSON.parse(row.targetDefs)).toEqual(['Pawn'])
    expect(row.status).toBe('applied')
  })

  test('records no-match and vanilla patches alike', () => {
    const db = new Database(dbPath, { readonly: true })
    const stats = Object.fromEntries(countPatchOpsByStatus(db).map(r => [r.status, r.n]))
    const coreOps = searchPatchOps(db, { packageId: 'ludeon.rimworld' })
    db.close()

    expect(stats).toMatchObject({ applied: 3, 'no-match': 1 })
    // vanilla Core patch ops land in the table with the builtin mod row
    expect(coreOps).toHaveLength(1)
    expect(coreOps[0]!.xpath).toContain('GunBase')
  })

  test('patched view: patched comps replace the originals', () => {
    const db = new Database(dbPath, { readonly: true })
    const rows = getPatchedDefs(db, 'Pawn')
    db.close()

    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0]!.payload)
    expect(payload.comps.li.map((li: any) => li.compClass)).toEqual(['NewComp', 'AnotherComp'])
    expect(JSON.parse(rows[0]!.changedBy)).toEqual([2])
  })

  test('patched view: patching an abstract def flows into children (patch before inheritance)', () => {
    const db = new Database(dbPath, { readonly: true })
    const rows = getPatchedDefs(db, 'Revolver')
    db.close()

    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0]!.payload)
    expect(payload.thingClass).toBe('PatchedClass') // inherited from patched GunBase
    expect(payload.statBases.MaxHitPoints).toBe(100)
  })

  test('patch-added defs override everything (DefDatabase patch-def semantics)', () => {
    const db = new Database(dbPath, { readonly: true })
    const rows = getPatchedDefs(db, 'PatchRecipe')
    db.close()

    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.payload).label).toBe('patch-made')
  })

  test('same-mod duplicate defName keeps the first; MayRequire-pruned defs stay out', () => {
    const db = new Database(dbPath, { readonly: true })
    const modThing = getPatchedDefs(db, 'ModThing')
    const gated = getPatchedDefs(db, 'MayRequireGated')
    db.close()

    expect(modThing).toHaveLength(1)
    expect(JSON.parse(modThing[0]!.payload).label).toBe('first')
    expect(gated).toHaveLength(0)
  })
})

describe('index-patches --skip-patches', () => {
  test('records metadata only and clears patched_defs', async () => {
    const skipDbPath = join(tempRoot, 'skip.db')
    const db = new Database(skipDbPath)
    ensureSchema(db)
    replaceMods(db, [mod('ludeon.rimworld', 0, 'Core'), mod('beta.mod', 1, 'Beta Mod')])
    db.close()

    await rebuildPatchesIndex(
      skipDbPath,
      { skipApply: true },
      join(tempRoot, 'defs'),
      join(tempRoot, 'patches'),
      join(tempRoot, 'mods'),
      join(tempRoot, 'manifest.json'),
    )

    const ro = new Database(skipDbPath, { readonly: true })
    const stats = Object.fromEntries(countPatchOpsByStatus(ro).map(r => [r.status, r.n]))
    const patched = getPatchedDefs(ro, 'Pawn')
    ro.close()

    expect(stats['not-evaluated']).toBeGreaterThanOrEqual(4)
    expect(patched).toHaveLength(0)
  })
})
