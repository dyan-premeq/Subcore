import type { CsharpIndexRow, SqlNamedParams } from '../types'
import { file, Glob } from 'bun'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { indexDbPath, sourcePath } from '../utils/env'
import { ensureSchema } from '../db/schema'
import { replaceCsharpIndex } from '../repositories/csharp-repo'

interface CsharpIndexInsertRow {
  $typeName: CsharpIndexRow['typeName']
  $filePath: CsharpIndexRow['filePath']
  $startLine: CsharpIndexRow['startLine']
}

type CsharpIndexInsertParams = SqlNamedParams & CsharpIndexInsertRow

const typeRegex =
  /^\s*(?:public|private|protected|internal|abstract|sealed|static|partial|readonly|unsafe|\s)*\s+(?:class|struct|interface|enum)\s+([a-zA-Z0-9_]+)/

export async function rebuildCsharpIndex(
  dbPath = indexDbPath,
  csharpSourcePath = sourcePath,
) {
  console.log(`Scanning C# source in: ${csharpSourcePath}`)

  const db = new Database(dbPath)

  try {
    ensureSchema(db)

    db.run('DELETE FROM csharp_index')

    const glob = new Glob('**/*.cs')

    let fileCount = 0
    let typeCount = 0
    const batch: CsharpIndexInsertParams[] = []

    for await (const relativePath of glob.scan({
      cwd: csharpSourcePath,
      onlyFiles: true,
    })) {
      fileCount += 1

      const absolutePath = join(csharpSourcePath, relativePath)
      // A partial index is invalid, so source read errors must abort the rebuild.
      const content = await file(absolutePath).text()
      const lines = content.split(/\r?\n/)

      const normalizedPath = relativePath.replaceAll('\\', '/')

      lines.forEach((line, index) => {
        const match = line.match(typeRegex)
        if (match) {
          const typeName = match[1]

          batch.push({
            $typeName: typeName,
            $filePath: normalizedPath,
            $startLine: index, // 0-indexed
          })
          typeCount++
        }
      })
    }

    console.log(`Found ${fileCount} files. Writing ${typeCount} types to DB...`)

    replaceCsharpIndex(
      db,
      batch.map(entry => ({
        typeName: entry.$typeName as string,
        filePath: entry.$filePath as string,
        startLine: entry.$startLine as number,
      })),
    )
    console.log(`Indexing complete.`)
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  await rebuildCsharpIndex()
}
