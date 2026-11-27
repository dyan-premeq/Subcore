import { CSHARP_TYPE_DECLARATION } from '../utils/csharp-type'
import { file, Glob } from 'bun'
import type { Database } from 'bun:sqlite'
import { join, posix } from 'node:path'
import { assetsPath, indexDbPath } from '../utils/env'
import { withIndexWriter } from '../db/writer'
import type { AssetDirectory } from './index-source'
import { replaceCsharpIndex, type CsharpInsertRow } from '../repositories/csharp-repo'
import { replaceHarmonyPatches, type HarmonyInsertRow } from '../repositories/harmony-repo'
import { extractHarmonyPatches } from '../utils/harmony-parse'

// scan roots: the vanilla decompile plus every imported mod's root Source/
// and decompiled assemblies. Old version folders stay unindexed (reference
// corpus only).
const SCAN_PATTERNS = [
  'Source/**/*.cs',
  'Mods/*/Source/**/*.cs',
  'Mods/*/Source-decompiled/**/*.cs',
]

/**
 * Rebuilds csharp_index (types) and harmony_patches (static Harmony parse)
 * from dist/assets. filePath is stored relative to dist/assets.
 */
export async function rebuildCsharpIndex(
  dbPath = indexDbPath,
  assetsRoot = assetsPath,
) {
  return withIndexWriter(dbPath, db => indexCsharp(db, assetsRoot))
}

export async function indexCsharp(
  db: Database, assetsRoot: string, directories?: AssetDirectory[], changedIds: (number | null)[] = [], clearAll = !directories,
) {
  const modIdByDir = loadModIdByDir(db)
  if (!clearAll) {
    for (const id of changedIds) {
      db.query('DELETE FROM csharp_index WHERE modId IS ?').run(id)
      db.query('DELETE FROM harmony_patches WHERE modId IS ?').run(id)
    }
  } else {
    db.run('DELETE FROM csharp_index')
    db.run('DELETE FROM harmony_patches')
  }

  let fileCount = 0
  let typeCount = 0
  const typeRows: CsharpInsertRow[] = []
  const harmonyRows: HarmonyInsertRow[] = []

  const scans = directories
    ? directories.flatMap(({ dir, prefix }) => (prefix === 'Source' ? ['**/*.cs'] : ['Source/**/*.cs', 'Source-decompiled/**/*.cs'])
        .map(pattern => ({ dir, prefix, pattern })))
    : SCAN_PATTERNS.map(pattern => ({ dir: assetsRoot, prefix: '', pattern }))
  for (const { dir, prefix, pattern } of scans) {
    for await (const entry of new Glob(pattern).scan({
      cwd: dir,
      onlyFiles: true,
    })) {
      const relativePath = posix.join(prefix, entry.replaceAll('\\', '/'))
      const modId = modIdForPath(relativePath, modIdByDir)
      fileCount += 1

      // A partial index is invalid, so source read errors must abort the rebuild.
      const content = await file(join(dir, entry)).text()

      const patches = extractHarmonyPatches(content)
      for (const patch of patches) {
        harmonyRows.push({ ...patch, modId, filePath: relativePath })
      }

      const lines = content.split(/\r?\n/)
      lines.forEach((line, index) => {
        const match = line.match(CSHARP_TYPE_DECLARATION)
        if (match) {
          typeRows.push({
            typeName: match[1],
            filePath: relativePath,
            startLine: index, // 0-indexed
            modId,
          })
          typeCount++
        }
      })
    }
  }

  console.error(
    `Found ${fileCount} files / ${typeCount} types / ${harmonyRows.length} harmony patches. Writing to DB...`,
  )

  replaceCsharpIndex(db, typeRows)
  replaceHarmonyPatches(db, harmonyRows)
  console.error(`Indexing complete.`)
}

/** Mods/<dir> → modId from the mods table (community mods only). */
function loadModIdByDir(db: Database): Map<string, number> {
  const rows = db
    .query<{ modId: number; assetPath: string }, []>(
      "SELECT modId, assetPath FROM mods WHERE assetPath LIKE 'Mods/%'",
    )
    .all()
  return new Map(rows.map(row => [row.assetPath.slice('Mods/'.length), row.modId]))
}

function modIdForPath(
  relativePath: string,
  modIdByDir: Map<string, number>,
): number | null {
  if (!relativePath.startsWith('Mods/')) return null
  const dir = relativePath.split('/')[1]
  const modId = modIdByDir.get(dir)
  if (modId === undefined) {
    throw new Error(
      `C# file under unknown mod dir '${dir}' — run "bun run index:mods" first: ${relativePath}`,
    )
  }
  return modId
}

if (import.meta.main) {
  await rebuildCsharpIndex()
}
