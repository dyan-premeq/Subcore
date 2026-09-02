import { file, Glob } from 'bun'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { assetsPath, indexDbPath } from '../utils/env'
import { ensureSchema } from '../db/schema'

/**
 * Rebuilds source_files + source_fts from every text file under assetsRoot.
 * Returns the file count.
 */
export async function indexSourceFiles(db: Database, assetsRoot: string): Promise<number> {
  db.run('DELETE FROM source_files')
  // contentless FTS5 tables are only cleared via this command
  db.run("INSERT INTO source_fts(source_fts) VALUES('delete-all')")

  const insertFile = db.prepare('INSERT INTO source_files (id, path) VALUES ($id, $path)')
  const insertFts = db.prepare('INSERT INTO source_fts (rowid, body) VALUES ($id, $body)')

  // Manual BEGIN/COMMIT: db.transaction() cannot wrap an async file loop, and
  // buffering the whole tree (hundreds of MB) before writing is not an option.
  let id = 0
  db.run('BEGIN')
  for await (const entry of new Glob('**/*').scan({
    cwd: assetsRoot,
    onlyFiles: true,
  })) {
    const relativePath = entry.replaceAll('\\', '/')
    // A partial index is invalid, so source read errors must abort the rebuild
    // (the open transaction is discarded with the connection).
    const buffer = await file(join(assetsRoot, relativePath)).arrayBuffer()
    // rg's binary criterion: a NUL byte within the first 8KB marks a binary file.
    if (new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192)).includes(0)) continue
    id += 1
    insertFile.run({ $id: id, $path: relativePath })
    insertFts.run({ $id: id, $body: new TextDecoder().decode(buffer) })
  }
  db.run('COMMIT')

  return id
}

export async function rebuildSourceIndex(
  dbPath = indexDbPath,
  assetsRoot = assetsPath,
): Promise<void> {
  console.log(`Scanning all text files in: ${assetsRoot}`)

  const db = new Database(dbPath)

  try {
    ensureSchema(db)
    const fileCount = await indexSourceFiles(db, assetsRoot)
    console.log(`Indexed ${fileCount} text files into source_fts.`)
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  await rebuildSourceIndex()
}
