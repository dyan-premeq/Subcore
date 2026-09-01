import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { write } from 'bun'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rebuildCsharpIndex } from '../../src/scripts/index-csharp'
import { ensureSchema } from '../../src/db/schema'
import { replaceMods, type ModInsertRow } from '../../src/repositories/mods-repo'
import { rmTemp } from '../helpers/fs'

const tempDirs: string[] = []

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'rimsage-index-csharp-'))
  tempDirs.push(dir)
  return dir
}

function seedMod(dbPath: string, packageId: string, assetPath: string): number {
  const db = new Database(dbPath)
  try {
    ensureSchema(db)
    const row: ModInsertRow = {
      packageId,
      name: packageId,
      author: null,
      source: 'workshop',
      rootPath: '',
      assetPath,
      loadOrder: 1,
      inProfile: true,
      playerActive: false,
      activeFolders: null,
      warnings: [],
      supportedVersions: ['1.6'],
      dependencies: [],
      dataCategory: null,
    }
    replaceMods(db, [row])
    return (
      db.query<{ modId: number }, [string]>('SELECT modId FROM mods WHERE packageId = ?')
        .get(packageId)!.modId
    )
  } finally {
    db.close()
  }
}

describe('index-csharp script', () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rmTemp(dir)
    }
  })

  test('scans vanilla root and mod roots, resolves modId, keeps same-name types apart', async () => {
    const tempRoot = await makeTempDir()
    const assetsRoot = join(tempRoot, 'assets')
    const dbPath = join(tempRoot, 'index.db')

    await mkdir(join(assetsRoot, 'Source/Verse'), { recursive: true })
    await write(
      join(assetsRoot, 'Source/Verse/Shared.cs'),
      'namespace Verse;\n\npublic class Shared\n{\n}\n',
    )

    await mkdir(join(assetsRoot, 'Mods/test.mod/Source'), { recursive: true })
    await write(
      join(assetsRoot, 'Mods/test.mod/Source/Shared.cs'),
      'public class Shared\n{\n}\n',
    )
    // reference corpus: old version folders are never indexed
    await mkdir(join(assetsRoot, 'Mods/test.mod/1.5/Source'), { recursive: true })
    await write(
      join(assetsRoot, 'Mods/test.mod/1.5/Source/Shared.cs'),
      'public class Shared\n{\n}\n',
    )

    const modId = seedMod(dbPath, 'test.mod', 'Mods/test.mod')
    await rebuildCsharpIndex(dbPath, assetsRoot)

    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db
        .query<
          { modId: number | null; filePath: string },
          []
        >("SELECT modId, filePath FROM csharp_index WHERE typeName = 'Shared' ORDER BY filePath")
        .all()

      expect(rows).toEqual([
        { modId, filePath: 'Mods/test.mod/Source/Shared.cs' },
        { modId: null, filePath: 'Source/Verse/Shared.cs' },
      ])
    } finally {
      db.close()
    }
  })

  test('fills harmony_patches from mod sources and the vanilla root', async () => {
    const tempRoot = await makeTempDir()
    const assetsRoot = join(tempRoot, 'assets')
    const dbPath = join(tempRoot, 'index.db')

    await mkdir(join(assetsRoot, 'Mods/test.mod/Source-decompiled'), { recursive: true })
    await write(
      join(assetsRoot, 'Mods/test.mod/Source-decompiled/Mod.decompiled.cs'),
      '[HarmonyPatch(typeof(PawnUtility), "CanPickUp")]\npublic static class CanPickUp_Patch\n{\n    [HarmonyPrefix]\n    public static void Prefix() { }\n}\n',
    )
    await mkdir(join(assetsRoot, 'Source'), { recursive: true })
    await write(
      join(assetsRoot, 'Source/Boot.cs'),
      'public class Boot\n{\n    public static void Init() { new Harmony("x").PatchAll(); }\n}\n',
    )

    const modId = seedMod(dbPath, 'test.mod', 'Mods/test.mod')
    await rebuildCsharpIndex(dbPath, assetsRoot)

    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db
        .query<
          { modId: number | null; patchClass: string; targetType: string; prefix: number },
          []
        >('SELECT modId, patchClass, targetType, prefix FROM harmony_patches ORDER BY targetType')
        .all()

      expect(rows).toEqual([
        { modId: null, patchClass: 'Boot', targetType: '*Assembly*', prefix: 0 },
        { modId, patchClass: 'CanPickUp_Patch', targetType: 'PawnUtility', prefix: 1 },
      ])
    } finally {
      db.close()
    }
  })

  test('C# files under an unknown mod dir fail loudly', async () => {
    const tempRoot = await makeTempDir()
    const assetsRoot = join(tempRoot, 'assets')
    const dbPath = join(tempRoot, 'index.db')

    await mkdir(join(assetsRoot, 'Mods/ghost.mod/Source'), { recursive: true })
    await write(join(assetsRoot, 'Mods/ghost.mod/Source/G.cs'), 'public class G\n{\n}\n')

    // no mods table rows: ghost.mod is unknown
    const db = new Database(dbPath)
    ensureSchema(db)
    db.close()

    await expect(rebuildCsharpIndex(dbPath, assetsRoot)).rejects.toThrow(
      /unknown mod dir 'ghost.mod'/,
    )
  })
})
