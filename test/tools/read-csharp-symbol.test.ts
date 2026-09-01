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
  source: 'workshop',
  assetPath: 'Mods/test.mod',
  loadOrder: 1,
  inProfile: true,
  activeFolders: null,
  warnings: [],
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
      'Source/TypeX.cs',
      `public class TypeX
{
    public static int SomeField;
}`,
    ],
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

  test('resolves a namespace-qualified symbol by its bare tail', async () => {
    const text = (
      await readCsharpSymbol(db, sourcePath, 'Some.Namespace.TypeX')
    ).content[0].text

    expect(text).toContain('// File: Source/TypeX.cs')
    expect(text).toContain('public class TypeX')
  })

  test('normalizes file_path variants (./ prefix, backslashes, dist/assets/)', async () => {
    const dotSlash = (
      await readCsharpSymbol(
        db,
        sourcePath,
        'Option',
        undefined,
        './Source/Two/Option.cs',
      )
    ).content[0].text
    expect(dotSlash).toContain('// File: Source/Two/Option.cs')

    const backslashes = (
      await readCsharpSymbol(
        db,
        sourcePath,
        'Option',
        undefined,
        'Mods\\test.mod\\Source\\Option.cs',
      )
    ).content[0].text
    expect(backslashes).toContain('// File: Mods/test.mod/Source/Option.cs')

    const assetsPrefix = (
      await readCsharpSymbol(
        db,
        sourcePath,
        'Option',
        undefined,
        'dist/assets/Source/One/Option.cs',
      )
    ).content[0].text
    expect(assetsPrefix).toContain('// File: Source/One/Option.cs')
  })

  test('lists candidates when file_path matches none of the definitions', async () => {
    const text = (
      await readCsharpSymbol(
        db,
        sourcePath,
        'Option',
        undefined,
        'Source/Nope/Option.cs',
      )
    ).content[0].text

    expect(text).toContain(
      "file_path 'Source/Nope/Option.cs' matched none of its 3 definitions",
    )
    expect(text).toContain('[vanilla] Source/One/Option.cs (line 1)')
  })

  test('renders a field declaration member', async () => {
    const text = (await readCsharpSymbol(db, sourcePath, 'TypeX', 'SomeField'))
      .content[0].text

    expect(text).toContain('public static int SomeField;')
  })

  test('reports a missing member', async () => {
    const text = (
      await readCsharpSymbol(db, sourcePath, 'Thing', 'MissingMethod')
    ).content[0].text

    expect(text).toContain(
      "Member 'MissingMethod' in type 'Thing' not found in index",
    )
  })
})

describe('read_csharp_symbol over stdio', () => {
  test(
    'a legacy typeName argument is rejected by strictObject and the rich error names symbol',
    async () => {
      const proc = Bun.spawn(['bun', 'src/stdio.ts'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      })

      try {
        const nextMessage = lineReader(proc)

        proc.stdin.write(
          [
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2026-07-28',
                capabilities: {},
                clientInfo: { name: 'test', version: '0' },
              },
            }),
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'read_csharp_symbol',
                arguments: { typeName: 'Thing' },
              },
            }),
          ]
            .map(line => line + '\n')
            .join(''),
        )
        proc.stdin.flush()

        let response:
          | {
              error?: unknown
              result?: { isError?: unknown; content?: Array<{ text?: unknown }> }
            }
          | undefined
        while (!response) {
          const msg = await nextMessage()
          if (msg.id === 2) response = msg
        }

        expect(response.error).toBeUndefined()
        expect(response.result!.isError).toBe(true)
        const text = response.result!.content![0]!.text as string
        expect(text).toContain('Input validation error')
        expect(text).toContain('read_csharp_symbol')
        expect(text).toContain('"typeName"')
        expect(text).toContain('symbol')
      } finally {
        proc.kill()
      }
    },
    60_000,
  )
})

/** Reads newline-delimited JSON-RPC messages from the server's stdout. */
function lineReader(proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>) {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  return async function nextMessage(): Promise<any> {
    for (;;) {
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) return JSON.parse(line)
      }
      const { done, value } = await reader.read()
      if (done) throw new Error('server exited before answering')
      buffer += decoder.decode(value, { stream: true })
    }
  }
}
