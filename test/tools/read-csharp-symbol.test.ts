import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { write } from 'bun'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCsharpSymbol } from '../../src/tools/read-csharp-symbol'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'

let db: Database
let sourcePath: string

const modRow: ModInsertRow = {
  packageId: 'test.mod',
  name: 'test.mod',
  author: null,
  source: 'workshop',
  rootPath: '',
  assetPath: 'Mods/test.mod',
  loadOrder: 1,
  inProfile: true,
  playerActive: false,
  activeFolders: null,
  warnings: [],
  supportedVersions: ['1.6'],
  dependencies: [],
  dataCategory: null,
}

beforeAll(async () => {
  db = new Database(':memory:')
  ensureSchema(db)
  replaceMods(db, [modRow])

  sourcePath = await mkdtemp(join(tmpdir(), 'rimsage-symbols-'))
  await mkdir(join(sourcePath, 'One'))
  await mkdir(join(sourcePath, 'Two'))

  const sources = new Map([
    [
      'Source/Thing.cs',
      `public class Thing
{
    public virtual void ExposeData()
    {
        Scribe_Defs.Look();
    }
}`,
    ],
    [
      'Source/Alert.cs',
      `public abstract class Alert
{
    public abstract AlertReport GetReport();
}`,
    ],
    ['Source/One/Option.cs', 'public class Option\n{\n}'],
    ['Source/Two/Option.cs', 'public class Option\n{\n}'],
    ['Mods/test.mod/Source/Option.cs', 'public class Option\n{\n}'],
    [
      'Source/LargeType.cs',
      `public class LargeType
{
${Array.from({ length: 400 }, (_, index) => `    public int Field${index};`).join('\n')}
}`,
    ],
  ])

  const insert = db.prepare(`
    INSERT INTO csharp_index (typeName, filePath, startLine, modId)
    VALUES ($typeName, $filePath, 0, $modId)
  `)

  for (const [filePath, content] of sources) {
    await write(join(sourcePath, filePath), content)
    insert.run({
      $typeName: filePath.split('/').at(-1)!.replace('.cs', ''),
      $filePath: filePath,
      $modId: filePath.startsWith('Mods/') ? 1 : null,
    })
  }
})

afterAll(async () => {
  db.close()
  await rm(sourcePath, { force: true, recursive: true })
})

describe('read-csharp-symbol', () => {
  test('renders a method from an indexed type', async () => {
    const text = (await readCsharpSymbol(db, sourcePath, 'Thing', 'ExposeData'))
      .content[0].text

    expect(text).toContain('// File: Source/Thing.cs')
    expect(text).toContain('public virtual void ExposeData()')
    expect(text).toContain('Scribe_Defs.Look')
  })

  test('renders abstract members that end with semicolons', async () => {
    const text = (await readCsharpSymbol(db, sourcePath, 'Alert', 'GetReport'))
      .content[0].text

    expect(text).toContain('public abstract AlertReport GetReport();')
  })

  test('lists every file defining a shared name instead of dumping all bodies', async () => {
    const text = (await readCsharpSymbol(db, sourcePath, 'Option')).content[0]
      .text

    expect(text).toContain("Type 'Option' is defined in 3 files")
    expect(text).toContain('[vanilla] Source/One/Option.cs (line 1)')
    expect(text).toContain('[test.mod] Mods/test.mod/Source/Option.cs (line 1)')
    expect(text).toContain('with file_path to pick one')
  })

  test('file_path disambiguates a shared name', async () => {
    const text = (
      await readCsharpSymbol(db, sourcePath, 'Option', undefined, 'Source/Two/Option.cs')
    ).content[0].text

    expect(text).toContain('// File: Source/Two/Option.cs')
  })

  test('summarizes large type definitions', async () => {
    const text = (await readCsharpSymbol(db, sourcePath, 'LargeType'))
      .content[0].text

    expect(text).toContain('[AUTO-SUMMARY:')
    expect(text).toContain('[SYSTEM NOTE]')
  })

  test('reports a missing member', async () => {
    const text = (
      await readCsharpSymbol(db, sourcePath, 'Thing', 'MissingMethod')
    ).content[0].text

    expect(text).toContain(
      "Method 'MissingMethod' in type 'Thing' not found in index",
    )
  })
})
