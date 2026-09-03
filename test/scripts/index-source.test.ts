import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { write } from 'bun'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { indexSourceFiles, rebuildSourceIndex } from '../../src/scripts/index-source'
import {
  findFilesContaining,
  findFilesContainingFragment,
  MAX_EXPANDED_TERMS,
} from '../../src/repositories/source-fts-repo'
import { ensureSchema } from '../../src/db/schema'
import { rmTemp } from '../helpers/fs'

const tempDirs: string[] = []

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'rimsage-index-source-'))
  tempDirs.push(dir)
  return dir
}

async function seedAssets(assetsRoot: string) {
  await mkdir(join(assetsRoot, 'Defs'), { recursive: true })
  await write(
    join(assetsRoot, 'Defs/a.xml'),
    '<RimworldDefs>\n  <ThingDef>\n    <defName>Some_Def</defName>\n  </ThingDef>\n</RimworldDefs>\n',
  )

  await mkdir(join(assetsRoot, 'Mods/X/Source-decompiled'), { recursive: true })
  await write(
    join(assetsRoot, 'Mods/X/Source-decompiled/b.cs'),
    'namespace Kiiro.StorytellerDef_Custom;\n\npublic static class UsesIt\n{\n    public static void Fire() => Log(Some_Def);\n}\n',
  )

  await mkdir(join(assetsRoot, 'Mods/X/About'), { recursive: true })
  await write(join(assetsRoot, 'Mods/X/About/About.txt'), 'Totally unrelated mod blurb.\n')

  await mkdir(join(assetsRoot, 'Mods/X/Assemblies'), { recursive: true })
  await write(join(assetsRoot, 'Mods/X/Assemblies/x.dll'), new Uint8Array([0x4d, 0x5a, 0x00, 0x01]))
}

describe('index-source script', () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rmTemp(dir)
    }
  })

  test('indexes text files only, with posix paths, and answers token-AND queries', async () => {
    const tempRoot = await makeTempDir()
    const assetsRoot = join(tempRoot, 'assets')
    const dbPath = join(tempRoot, 'index.db')
    await seedAssets(assetsRoot)

    const db = new Database(dbPath)
    try {
      ensureSchema(db)

      expect(await indexSourceFiles(db, assetsRoot)).toBe(3)

      const paths = db.query<{ path: string }, []>('SELECT path FROM source_files').all()
        .map(row => row.path)
        .sort()
      expect(paths).toEqual([
        'Defs/a.xml',
        'Mods/X/About/About.txt',
        'Mods/X/Source-decompiled/b.cs',
      ])
      for (const path of paths) {
        expect(path).not.toContain('\\')
        expect(path).not.toContain('x.dll')
      }

      expect(findFilesContaining(db, 'Some_Def')).toEqual([
        'Defs/a.xml',
        'Mods/X/Source-decompiled/b.cs',
      ])
      // no partial-token matches
      expect(findFilesContaining(db, 'Some')).toEqual([])
      // dotted names AND their identifier tokens
      expect(findFilesContaining(db, 'Kiiro.StorytellerDef_Custom')).toEqual([
        'Mods/X/Source-decompiled/b.cs',
      ])

      // idempotent rebuild: no duplication
      expect(await indexSourceFiles(db, assetsRoot)).toBe(3)
      expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM source_files').get()!.n).toBe(3)
    } finally {
      db.close()
    }
  })

  test('rebuildSourceIndex runs the file-path variant end to end', async () => {
    const tempRoot = await makeTempDir()
    const assetsRoot = join(tempRoot, 'assets')
    const dbPath = join(tempRoot, 'index.db')
    await seedAssets(assetsRoot)

    await rebuildSourceIndex(dbPath, assetsRoot)

    const db = new Database(dbPath, { readonly: true })
    try {
      expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM source_files').get()!.n).toBe(3)
    } finally {
      db.close()
    }
  })

  test('findFilesContainingFragment expands substring fragments over the vocab', async () => {
    const tempRoot = await makeTempDir()
    const assetsRoot = join(tempRoot, 'assets')
    await mkdir(join(assetsRoot, 'Defs'), { recursive: true })
    await write(join(assetsRoot, 'Defs/race.xml'), '<alienrefugeekinds>2</alienrefugeekinds>\n')
    await write(join(assetsRoot, 'Defs/other.xml'), '<storyteller>custom</storyteller>\n')

    const db = new Database(join(tempRoot, 'index.db'))
    try {
      ensureSchema(db)
      await indexSourceFiles(db, assetsRoot)

      // substring of a single token: rg substring semantics preserved
      expect(findFilesContainingFragment(db, 'refugee')).toEqual(['Defs/race.xml'])
      // case-insensitive (vocab terms are tokenizer-folded)
      expect(findFilesContainingFragment(db, 'Refugee')).toEqual(['Defs/race.xml'])
      // no term contains the fragment
      expect(findFilesContainingFragment(db, 'refugees')).toEqual([])
    } finally {
      db.close()
    }
  })

  test('MAX_EXPANDED_TERMS is the documented vocab cap', () => {
    expect(MAX_EXPANDED_TERMS).toBe(5000)
  })
})
