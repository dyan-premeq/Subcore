import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { textResponse } from '../utils/mcp-response'
import { searchPatchOps } from '../repositories/patches-repo'
import { parseJsonArray } from '../utils/json'

export interface SearchPatchesOptions {
  defName?: string
  packageId?: string
  opClass?: string
  limit?: number
}

/** Registered as outputSchema for search_patches in server.ts. */
export const searchPatchesOutputSchema = z.object({
  total: z.number(),
  results: z.array(
    z.object({
      packageId: z.string(),
      filePath: z.string(),
      seq: z.number(),
      opClass: z.string(),
      xpath: z.string().nullable(),
      targetDefs: z.array(z.string()),
      status: z.string(),
    }),
  ),
})

export type SearchPatchesStructured = z.infer<typeof searchPatchesOutputSchema>

export function searchPatches(db: Database, options: SearchPatchesOptions = {}): ReturnType<
  typeof textResponse
> & { structuredContent: SearchPatchesStructured } {
  const results = searchPatchOps(
    db,
    { defName: options.defName, packageId: options.packageId, opClass: options.opClass },
    options.limit ?? 50,
  )
  const total = results[0]?.total ?? 0

  const rows = results.map(row => {
    const targetDefs = parseJsonArray(row.targetDefs, String)
    return {
      row,
      targetDefs,
      targetText:
        targetDefs.length > 0 ? ` → ${targetDefs.join(', ')}` : '',
    }
  })

  const structuredContent: SearchPatchesStructured = {
    total,
    results: rows.map(({ row, targetDefs }) => ({
      packageId: row.packageId,
      filePath: row.filePath,
      seq: row.seq,
      opClass: row.opClass,
      xpath: row.xpath,
      targetDefs,
      status: row.status,
    })),
  }

  if (total === 0) {
    const hint = options.defName
      ? ' No patch touches this defName — it may be unpatched, or patches were indexed with --skip-patches (targetDefs backfill needs evaluation).'
      : ''
    return {
      ...textResponse(`No patch operations found.${hint}`),
      structuredContent,
    }
  }

  const lines = rows.map(({ row, targetText }) => {
    const xpath = row.xpath ? ` ${row.xpath}` : ''
    return `[${row.packageId}] ${row.filePath} #${row.seq} ${row.opClass} (${row.status})${xpath}${targetText}`
  })

  return {
    ...textResponse(
      `Patch operations (${total}${total > results.length ? `, showing ${results.length}` : ''}):\n` +
        lines.join('\n'),
    ),
    structuredContent,
  }
}

