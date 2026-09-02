import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { findRefs } from '../../src/tools/find-refs'
import { ensureSchema } from '../../src/db/schema'
import { indexSourceFiles } from '../../src/scripts/index-source'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'
import { replaceDefs } from '../../src/repositories/defs-repo'
import { replacePatchOps } from '../../src/repositories/patches-repo'
import { replaceHarmonyPatches } from '../../src/repositories/harmony-repo'
import { PathSandbox } from '../../src/utils/path-sandbox'

// source quadrant is answered from the build-time FTS5 index (indexed in
// beforeAll over the shared fixture tree) plus a line-by-line exact regex
// pass; Ref_Thing appears in Defs/ (1), Source/ (1) and Mods/RefTraceMod
// (15: 4 files + ManyRefs x12). Trace_Util must appear in fixture files
// nowhere — it is harmony-only.
const sandbox = new PathSandbox(join(import.meta.dir, '../fixtures/game-root'))

let db: Database

function mod(packageId: string, modId: number, loadOrder: number, assetPath: string): ModInsertRow {
  return {
    packageId,
    name: packageId,
    source: loadOrder === 0 ? 'builtin' : 'workshop',
    assetPath,
    loadOrder,
    inProfile: true,
    activeFolders: null,
    warnings: [],
    dataCategory: null,
  }
}

beforeAll(async () => {
  db = new Database(':memory:')
  ensureSchema(db)
  await indexSourceFiles(db, sandbox.basePath)

  replaceMods(db, [
    mod('ludeon.rimworld', 1, 0, ''),
    mod('beta.mod', 2, 1, 'Mods/BetaCore'),
  ])

  // Ref_Thing is defined twice; beta.mod wins the load-order override chain
  replaceDefs(db, [
    {
      defName: 'Ref_Thing',
      defType: 'ThingDef',
      modId: 1,
      loadOrder: 0,
      label: 'vanilla',
      filePath: 'Defs/ThingDefs/Ref_Thing.xml',
      mayRequire: null,
      rawPayload: '{}',
      mergedPayload: '{}',
    },
    {
      defName: 'Ref_Thing',
      defType: 'ThingDef',
      modId: 2,
      loadOrder: 1,
      label: 'beta',
      filePath: 'Mods/BetaCore/Defs/Ref_Thing.xml',
      mayRequire: null,
      rawPayload: '{}',
      mergedPayload: '{}',
    },
  ])

  replacePatchOps(db, [
    {
      modId: 2,
      filePath: 'Mods/RefTraceMod/Patches/TracePatch.xml',
      seq: 0,
      opClass: 'patchoperationreplace',
      xpath: 'Defs/ThingDef[defName="Ref_Thing"]/label',
      xpathNorm: null,
      targetDefs: ['Ref_Thing'],
      status: 'applied',
    },
  ])

  // first row matches BOTH targetType and targetMethod -> merge must dedupe it
  replaceHarmonyPatches(db, [
    {
      modId: 2,
      filePath: 'Mods/RefTraceMod/Source-decompiled/RefTrace.decompiled.cs',
      patchClass: 'RefTracePatches',
      targetType: 'Trace_Util',
      targetMethod: 'Trace_Util',
      prefix: true,
      postfix: false,
      transpiler: false,
      finalizer: false,
    },
    {
      modId: 2,
      filePath: 'Mods/RefTraceMod/Source-decompiled/RefTrace.decompiled.cs',
      patchClass: 'RefTraceHelpers',
      targetType: 'Trace_Util',
      targetMethod: 'Other_Method',
      prefix: false,
      postfix: true,
      transpiler: false,
      finalizer: false,
    },
  ])
})

afterAll(() => {
  db.close()
})

describe('find_refs', () => {
  test('multi-layer name renders def + patch + source groups in one call', async () => {
    const result = await findRefs(db, sandbox, 'Ref_Thing')
    const text = result.content[0].text as string

    expect(text).toContain('References to "Ref_Thing"')

    // source groups in deterministic order: Defs/ -> Source/ -> Mods/<pkg>
    expect(text).toContain('[Defs/] 1 match')
    expect(text).toContain('Defs/ThingDefs/Ref_Thing.xml:4:     <defName>Ref_Thing</defName>')
    expect(text).toContain('[Source/] 1 match')
    expect(text).toContain('Source/RefTrace.cs:4:')
    expect(text).toContain('[Mods/RefTraceMod] 15 matches')
    // per-group cap: 10 shown, rest collapses into a drill-down hint
    expect(text).toContain(
      "... use search_source with scope:'RefTraceMod' to see all 15 matches",
    )
    expect(text).toContain('Mods/RefTraceMod/Source-decompiled/ManyRefs.cs:7:')

    // def section: both defining mods, load-order winner marked effective
    expect(text).toContain('Def definitions:')
    expect(text).toContain(
      'ThingDef — defined by ludeon.rimworld → beta.mod, effective: beta.mod',
    )

    // patch section
    expect(text).toContain(
      '[beta.mod] Mods/RefTraceMod/Patches/TracePatch.xml #0 patchoperationreplace (applied) Defs/ThingDef[defName="Ref_Thing"]/label → Ref_Thing',
    )

    // this name has no harmony rows, so the harmony section stays omitted
    expect(text).not.toContain('Harmony patches')
  })

  test('harmony-only name renders only the harmony section', async () => {
    const result = await findRefs(db, sandbox, 'Trace_Util')
    const text = result.content[0].text as string

    expect(text).toContain('References to "Trace_Util"')
    expect(text).toContain('Harmony patches:')
    expect(text).toContain(
      '[beta.mod] RefTracePatches -> Trace_Util.Trace_Util [prefix]',
    )
    expect(text).toContain(
      '[beta.mod] RefTraceHelpers -> Trace_Util.Other_Method [postfix]',
    )
    expect(text).not.toContain('Full-text source matches')
    expect(text).not.toContain('Def definitions')
    expect(text).not.toContain('XML patch operations')
  })

  test('no hits anywhere yields the no-references message', async () => {
    const result = await findRefs(db, sandbox, 'NoSuch_Ref_Anywhere')

    expect(result.content[0].text).toBe(
      'No references to "NoSuch_Ref_Anywhere" found in any layer.',
    )
    expect(result.structuredContent).toEqual({
      defs: [],
      patches: [],
      harmony: [],
      sourceGroups: [],
    })
  })

  test('structuredContent carries the four fields with per-layer shapes', async () => {
    const result = await findRefs(db, sandbox, 'Ref_Thing')
    const sc = result.structuredContent

    expect(Object.keys(sc).sort()).toEqual(['defs', 'harmony', 'patches', 'sourceGroups'])

    expect(sc.defs).toEqual([
      {
        defType: 'ThingDef',
        packageId: 'ludeon.rimworld',
        loadOrder: 0,
        filePath: 'Defs/ThingDefs/Ref_Thing.xml',
        effective: false,
      },
      {
        defType: 'ThingDef',
        packageId: 'beta.mod',
        loadOrder: 1,
        filePath: 'Mods/BetaCore/Defs/Ref_Thing.xml',
        effective: true,
      },
    ])

    expect(sc.patches).toEqual([
      {
        packageId: 'beta.mod',
        filePath: 'Mods/RefTraceMod/Patches/TracePatch.xml',
        seq: 0,
        opClass: 'patchoperationreplace',
        xpath: 'Defs/ThingDef[defName="Ref_Thing"]/label',
        targetDefs: ['Ref_Thing'],
        status: 'applied',
      },
    ])

    expect(sc.harmony).toEqual([])

    expect(sc.sourceGroups).toHaveLength(3)
    expect(sc.sourceGroups[0]).toMatchObject({ scope: 'vanilla', total: 1 })
    expect(sc.sourceGroups[0]!.hits[0]).toMatchObject({
      file: 'Defs/ThingDefs/Ref_Thing.xml',
      line: 4,
      text: '    <defName>Ref_Thing</defName>',
    })
    expect(sc.sourceGroups[1]).toMatchObject({ scope: 'vanilla', total: 1 })
    expect(sc.sourceGroups[2]).toMatchObject({ scope: 'RefTraceMod', total: 15 })
    expect(sc.sourceGroups[2]!.hits).toHaveLength(10)
    expect(sc.sourceGroups[2]!.hits[0]!.file).toBe('Mods/RefTraceMod/Defs/TraceRef.xml')
  })
})
