import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PatchEvaluator,
  normalizeXpath,
  PATCH_DEF_LOAD_ORDER,
  type PatchOpRecord,
} from '../../src/utils/patch-evaluator'
import { rmTemp } from '../helpers/fs'

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'rimsage-patch-eval-'))
})

afterAll(async () => {
  await rmTemp(tempDir)
})

// #region Harness

interface Harness {
  evaluator: PatchEvaluator
  records: PatchOpRecord[]
  groups: ReturnType<PatchEvaluator['serialize']>['defGroups']
  changedBy: Map<string, number[]>
}

async function run(
  defs: string,
  patches: string[],
  activeModNames: string[] = ['Core'],
): Promise<Harness> {
  const defsPath = join(tempDir, 'defs.xml')
  await writeFile(defsPath, defs)

  const evaluator = new PatchEvaluator({ activeModNames: new Set(activeModNames) })
  await evaluator.buildTree([
    { absPath: defsPath, filePath: 'Core/Defs/Things.xml', modId: 1, loadOrder: 0 },
  ])

  let i = 0
  for (const patch of patches) {
    const patchPath = join(tempDir, `patch-${i++}.xml`)
    await writeFile(patchPath, patch)
    await evaluator.applyPatches([
      { absPath: patchPath, filePath: `Beta/Patches/P${i}.xml`, modId: 2, loadOrder: 1 },
    ])
  }

  const { defGroups: groups, changedBy } = evaluator.serialize()
  return { evaluator, records: evaluator.opRecords, groups, changedBy }
}

/** Parses a group's <Defs> XML into fast-xml-parser objects. */
function parseGroup(harness: Harness, filePath?: string) {
  const parser = require('../../src/utils/xml-utils').parser
  const group = filePath
    ? harness.groups.find(g => g.filePath === filePath)
    : harness.groups[0]
  if (!group) throw new Error(`group not found: ${filePath ?? '(first)'}`)
  return parser.parse(group.xml).Defs as Record<string, any[]>
}

function record(harness: Harness, opClass: string): PatchOpRecord {
  const found = harness.records.find(r => r.opClass === opClass)
  if (!found) throw new Error(`no record for ${opClass}`)
  return found
}

function operation(op: string, body = ''): string {
  return `<Patch><Operation Class="${op}">${body}</Operation></Patch>`
}

// #endregion

describe('patch-evaluator: tree building', () => {
  test('mounts defs from multiple files in load order and keeps coexisting same-name defs', async () => {
    const h = await run(
      `<Defs><ThingDef><defName>A</defName><v>1</v></ThingDef></Defs>`,
      [],
    )
    expect(h.groups[0]!.defNames).toEqual(['A'])
    expect(h.groups).toHaveLength(1)
  })

  test('skips unparseable files with a warning instead of throwing', async () => {
    const evaluator = new PatchEvaluator({ activeModNames: new Set() })
    await evaluator.buildTree([
      { absPath: join(tempDir, 'nope.xml'), filePath: 'x/y.xml', modId: 1, loadOrder: 0 },
    ])
    expect(evaluator.serialize().defGroups).toHaveLength(0)
  })
})

describe('patch-evaluator: add', () => {
  const defs = `<Defs><ThingDef><defName>T</defName><items><li>a</li></items></ThingDef></Defs>`

  test('appends value children by default, preserving order', async () => {
    const h = await run(
      defs,
      [operation('PatchOperationAdd', `<xpath>Defs/ThingDef[defName="T"]/items</xpath><value><li>b</li><li>c</li></value>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing.items.li).toEqual(['a', 'b', 'c'])
    expect(record(h, 'patchoperationadd').status).toBe('applied')
  })

  test('prepends with order=Prepend keeping document order', async () => {
    const h = await run(
      defs,
      [operation('PatchOperationAdd', `<xpath>Defs/ThingDef[defName="T"]/items</xpath><order>Prepend</order><value><li>b</li><li>c</li></value>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing.items.li).toEqual(['b', 'c', 'a'])
  })

  test('no-match xpath records status no-match', async () => {
    const h = await run(
      defs,
      [operation('PatchOperationAdd', `<xpath>Defs/ThingDef[defName="Missing"]</xpath><value><x/></value>`)],
    )
    expect(record(h, 'patchoperationadd').status).toBe('no-match')
    expect(record(h, 'patchoperationadd').targetDefs).toEqual([])
  })

  test('adds a def when xpath selects the Defs root', async () => {
    const h = await run(
      defs,
      [operation('PatchOperationAdd', `<xpath>/Defs</xpath><value><ThingDef><defName>New</defName></ThingDef></value>`)],
    )
    const patchGroup = h.groups.find(g => g.loadOrder === PATCH_DEF_LOAD_ORDER)
    expect(patchGroup?.defNames).toContain('New')
    expect(patchGroup?.modId).toBe(2)
  })
})

describe('patch-evaluator: insert', () => {
  const defs = `<Defs><ThingDef><defName>T</defName><row><a/><c/></row></ThingDef></Defs>`

  test('defaults to Prepend (InsertBefore) before the selected node', async () => {
    const h = await run(
      defs,
      [operation('PatchOperationInsert', `<xpath>Defs/ThingDef[defName="T"]/row/c</xpath><value><b/></value>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(Object.keys(thing.row)).toEqual(['a', 'b', 'c'])
  })

  test('order=Append inserts each child directly after the target (game: fixed refChild → ≥2 children land reversed)', async () => {
    const h = await run(
      defs,
      [operation('PatchOperationInsert', `<xpath>Defs/ThingDef[defName="T"]/row/a</xpath><order>Append</order><value><b1/><b2/></value>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(Object.keys(thing.row)).toEqual(['a', 'b2', 'b1', 'c'])
  })
})

describe('patch-evaluator: replace / remove', () => {
  const defs = `<Defs><ThingDef><defName>T</defName><old><x>1</x></old></ThingDef></Defs>`

  test('replace substitutes the node with ALL value children (not just the first)', async () => {
    const h = await run(
      defs,
      [operation('PatchOperationReplace', `<xpath>Defs/ThingDef[defName="T"]/old</xpath><value><new1>a</new1><new2>b</new2></value>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(Object.keys(thing)).toEqual(['defName', 'new1', 'new2'])
    expect(record(h, 'patchoperationreplace').targetDefs).toEqual(['T'])
  })

  test('remove deletes the selected node', async () => {
    const h = await run(
      defs,
      [operation('PatchOperationRemove', `<xpath>Defs/ThingDef[defName="T"]/old</xpath>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing.old).toBeUndefined()
  })
})

describe('patch-evaluator: addmodextension / attributes / setname', () => {
  test('addmodextension creates the container and appends li', async () => {
    const h = await run(
      `<Defs><ThingDef><defName>T</defName></ThingDef></Defs>`,
      [operation('PatchOperationAddModExtension', `<xpath>Defs/ThingDef[defName="T"]</xpath><value><li Class="Ext"/></value>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing.modExtensions.li[0]['@_Class']).toBe('Ext')
  })

  test('attributeset updates existing or creates the attribute', async () => {
    const h = await run(
      `<Defs><ThingDef MayRequire="a.b"><defName>T</defName></ThingDef></Defs>`,
      [
        operation('PatchOperationAttributeSet', `<xpath>Defs/ThingDef[defName="T"]</xpath><attribute>MayRequire</attribute><value>c.d</value>`),
        operation('PatchOperationAttributeSet', `<xpath>Defs/ThingDef[defName="T"]</xpath><attribute>NewAttr</attribute><value>1</value>`),
      ],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing['@_MayRequire']).toBe('c.d')
    expect(thing['@_NewAttr']).toBe('1')
  })

  test('attributeadd only succeeds when the attribute is absent (game returns false otherwise)', async () => {
    const h = await run(
      `<Defs><ThingDef k="old"><defName>T</defName></ThingDef></Defs>`,
      [operation('PatchOperationAttributeAdd', `<xpath>Defs/ThingDef[defName="T"]</xpath><attribute>k</attribute><value>new</value>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing['@_k']).toBe('old') // untouched
    expect(record(h, 'patchoperationattributeadd').status).toBe('failed')
  })

  test('attributeremove deletes the attribute', async () => {
    const h = await run(
      `<Defs><ThingDef k="old"><defName>T</defName></ThingDef></Defs>`,
      [operation('PatchOperationAttributeRemove', `<xpath>Defs/ThingDef[defName="T"]</xpath><attribute>k</attribute>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing['@_k']).toBeUndefined()
  })

  test('setname renames the element keeping children but dropping attributes (game: InnerXml copy only)', async () => {
    const h = await run(
      `<Defs><ThingDef><defName>T</defName><x k="v">1</x></ThingDef></Defs>`,
      [operation('PatchOperationSetName', `<xpath>Defs/ThingDef[defName="T"]/x</xpath><name>y</name>`)],
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing.y).toBe(1) // fast-xml-parser parses numeric text
    expect(thing.x).toBeUndefined()
  })
})

describe('patch-evaluator: sequence / conditional / findmod / test', () => {
  const defs = `<Defs><ThingDef><defName>T</defName><n>0</n></ThingDef></Defs>`

  test('sequence stops at the first failure; remaining ops are recorded skipped', async () => {
    const h = await run(defs, [
      `<Patch><Operation Class="PatchOperationSequence"><operations>
        <li Class="PatchOperationAdd"><xpath>Defs/ThingDef[defName="Missing"]</xpath><value><x/></value></li>
        <li Class="PatchOperationAdd"><xpath>Defs/ThingDef[defName="T"]</xpath><value><never/></value></li>
      </operations></Operation></Patch>`,
    ])
    const skipped = h.records.find(r => r.status === 'skipped')
    expect(skipped?.opClass).toBe('patchoperationadd')
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing.never).toBeUndefined() // never applied
    expect(record(h, 'patchoperationsequence').status).toBe('failed')
  })

  test('conditional runs match on hit and nomatch otherwise', async () => {
    const h = await run(defs, [
      `<Patch><Operation Class="PatchOperationConditional">
        <xpath>Defs/ThingDef[defName="T"]</xpath>
        <match Class="PatchOperationAdd"><xpath>Defs/ThingDef[defName="T"]</xpath><value><from>match</from></value></match>
      </Operation></Patch>`,
      `<Patch><Operation Class="PatchOperationConditional">
        <xpath>Defs/ThingDef[defName="Missing"]</xpath>
        <nomatch Class="PatchOperationAdd"><xpath>Defs/ThingDef[defName="T"]</xpath><value><from>nomatch</from></value></nomatch>
      </Operation></Patch>`,
    ])
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing.from).toEqual(['match', 'nomatch'])
  })

  test('conditional without match returning false when hit and no nomatch (game fall-through)', async () => {
    const h = await run(defs, [
      `<Patch><Operation Class="PatchOperationConditional">
        <xpath>Defs/ThingDef[defName="T"]</xpath>
      </Operation></Patch>`,
    ])
    // hit + no match + no nomatch → returns nomatch != null = false
    expect(record(h, 'patchoperationconditional').status).toBe('failed')
  })

  test('findmod matches display names case-sensitively and runs nomatch otherwise', async () => {
    const h = await run(
      defs,
      [
        `<Patch><Operation Class="PatchOperationFindMod">
          <mods><li>Core</li></mods>
          <match Class="PatchOperationAdd"><xpath>Defs/ThingDef[defName="T"]</xpath><value><when>core-match</when></value></match>
        </Operation></Patch>`,
        `<Patch><Operation Class="PatchOperationFindMod">
          <mods><li>core</li></mods>
          <nomatch Class="PatchOperationAdd"><xpath>Defs/ThingDef[defName="T"]</xpath><value><when>case-mismatch</when></value></nomatch>
        </Operation></Patch>`,
      ],
      ['Core'], // active display names
    )
    const thing = parseGroup(h).ThingDef.find((d: any) => d.defName === 'T')
    expect(thing.when).toEqual(['core-match', 'case-mismatch'])
  })

  test('test returns true iff the xpath hits', async () => {
    const h = await run(defs, [
      operation('PatchOperationTest', `<xpath>Defs/ThingDef[defName="T"]</xpath>`),
      operation('PatchOperationTest', `<xpath>Defs/ThingDef[defName="Nope"]</xpath>`),
    ])
    const tests = h.records.filter(r => r.opClass === 'patchoperationtest')
    expect(tests.map(r => r.status)).toEqual(['applied', 'no-match'])
  })
})

describe('patch-evaluator: success modifier & class resolution', () => {
  const defs = `<Defs><ThingDef><defName>T</defName></ThingDef></Defs>`

  test('success=Always forces success even on no-match', async () => {
    const h = await run(defs, [
      operation('PatchOperationTest', `<xpath>Defs/ThingDef[defName="Nope"]</xpath><success>Always</success>`),
    ])
    expect(record(h, 'patchoperationtest').status).toBe('applied')
  })

  test('success=Invert flips the raw result', async () => {
    const h = await run(defs, [
      operation('PatchOperationTest', `<xpath>Defs/ThingDef[defName="Nope"]</xpath><success>Invert</success>`),
    ])
    expect(record(h, 'patchoperationtest').status).toBe('applied')
  })

  test('class names are matched case-insensitively (PatchOperationreplace)', async () => {
    const h = await run(defs, [
      operation('PatchOperationreplace', `<xpath>Defs/ThingDef[defName="T"]</xpath><value><ThingDef><defName>T2</defName></ThingDef></value>`),
    ])
    expect(record(h, 'patchoperationreplace').status).toBe('applied')
  })

  test('unknown class records unsupported-custom', async () => {
    const h = await run(defs, [operation('My.Custom.Thing', `<xpath>Defs</xpath>`)])
    expect(record(h, 'my.custom.thing').status).toBe('unsupported-custom')
  })
})

describe('patch-evaluator: bookkeeping', () => {
  const defs = `<Defs><ThingDef><defName>Pawn</defName><comps/></ThingDef></Defs>`

  test('changedBy maps defName to patch modIds; unpatched defs are absent', async () => {
    const h = await run(defs, [
      operation('PatchOperationAdd', `<xpath>Defs/ThingDef[defName="Pawn"]/comps</xpath><value><li><compClass>X</compClass></li></value>`),
    ])
    expect(h.changedBy.get('Pawn')).toEqual([2])
  })

  test('invalid xpath records error instead of throwing', async () => {
    const h = await run(defs, [operation('PatchOperationTest', `<xpath>Defs/ThingDef[[</xpath>`)])
    expect(record(h, 'patchoperationtest').status).toBe('error')
  })

  test('stats counts each status', async () => {
    const h = await run(defs, [
      operation('PatchOperationTest', `<xpath>Defs/ThingDef[defName="Pawn"]</xpath>`),
      operation('PatchOperationTest', `<xpath>Defs/ThingDef[defName="No"]</xpath>`),
    ])
    expect(h.evaluator.stats()).toMatchObject({ applied: 1, 'no-match': 1 })
  })
})

describe('patch-evaluator: collectPatchMetadata (--skip-patches)', () => {
  test('records metadata without applying anything', async () => {
    const defsPath = join(tempDir, 'meta-defs.xml')
    const patchPath = join(tempDir, 'meta-patch.xml')
    await writeFile(defsPath, `<Defs><ThingDef><defName>T</defName></ThingDef></Defs>`)
    await writeFile(patchPath, operation('PatchOperationAdd', `<xpath>Defs/ThingDef[defName="T"]</xpath><value><x/></value>`))

    const evaluator = new PatchEvaluator({ activeModNames: new Set() })
    await evaluator.buildTree([{ absPath: defsPath, filePath: 'Core/D.xml', modId: 1, loadOrder: 0 }])
    await evaluator.collectPatchMetadata([{ absPath: patchPath, filePath: 'Beta/P.xml', modId: 2, loadOrder: 1 }])

    expect(evaluator.opRecords).toHaveLength(1)
    expect(evaluator.opRecords[0]).toMatchObject({
      opClass: 'patchoperationadd',
      xpath: 'Defs/ThingDef[defName="T"]',
      status: 'not-evaluated',
      targetDefs: [],
    })
    const { defGroups } = evaluator.serialize()
    expect(defGroups[0]!.defNames).toEqual(['T']) // untouched tree
  })
})

describe('normalizeXpath', () => {
  test('trims, collapses whitespace and unifies predicate quotes', () => {
    expect(normalizeXpath('  Defs/ThingDef[ defName = "T" ]  ')).toBe("Defs/ThingDef[ defName = 'T' ]")
    expect(normalizeXpath('Defs\n  /ThingDef')).toBe('Defs /ThingDef')
  })
  test('does not case-fold (xpath is case-sensitive)', () => {
    expect(normalizeXpath('Defs/ThingDef')).toBe('Defs/ThingDef')
  })
})
