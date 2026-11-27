import { file, Glob } from 'bun'
import type { Database } from 'bun:sqlite'
import { join, posix } from 'node:path'
import { assetsPath, indexDbPath } from '../utils/env'
import { withIndexWriter } from '../db/writer'

export interface AssetDirectory {
  /** Posix path relative to the published asset tree. */
  prefix: string
  /** A staged replacement, or the currently published directory. */
  dir: string
}

/** An absent directory in a partial update has only its old FTS rows removed. */
export async function indexSourceFiles(
  db: Database, assetsRoot: string, directories?: AssetDirectory[], removed: string[] = [], clearAll = !directories,
): Promise<number> {
  const ownsTransaction = !db.inTransaction
  if (ownsTransaction) db.run('BEGIN IMMEDIATE')
  try {
    if (!clearAll && directories) {
      const deleteFts = db.prepare('DELETE FROM source_fts WHERE rowid IN (SELECT id FROM source_files WHERE path GLOB ?)')
      const deleteFiles = db.prepare('DELETE FROM source_files WHERE path GLOB ?')
      for (const prefix of [...directories.map(d => d.prefix), ...removed]) {
        // Imported package directory names contain only letters, digits, dots and underscores.
        deleteFts.run(prefix + '/*')
        deleteFiles.run(prefix + '/*')
      }
    } else {
      db.run("INSERT INTO source_fts(source_fts) VALUES('delete-all')")
      db.run('DELETE FROM source_files')
    }

    const insertFile = db.prepare('INSERT INTO source_files (path) VALUES (?)')
    const insertFts = db.prepare('INSERT INTO source_fts (rowid, body) VALUES (?, ?)')
    const decoder = new TextDecoder()
    let count = 0
    for (const { dir, prefix } of directories ?? [{ dir: assetsRoot, prefix: '' }]) {
      for await (const entry of new Glob('**/*').scan({ cwd: dir, onlyFiles: true })) {
        const buffer = await file(join(dir, entry)).arrayBuffer()
        // Same binary criterion as rg.
        if (new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192)).includes(0)) continue
        const { lastInsertRowid } = insertFile.run(posix.join(prefix, entry.replaceAll('\\', '/')))
        insertFts.run(lastInsertRowid, decoder.decode(buffer))
        count++
      }
    }
    if (ownsTransaction) db.run('COMMIT')
    return count
  } catch (error) {
    if (ownsTransaction) db.run('ROLLBACK')
    throw error
  }
}

export async function rebuildSourceIndex(dbPath = indexDbPath, assetsRoot = assetsPath): Promise<void> {
  await withIndexWriter(dbPath, async db => {
    const count = await indexSourceFiles(db, assetsRoot)
    console.error(`Indexed ${count} text files into source_fts.`)
  })
}

if (import.meta.main) await rebuildSourceIndex()
