import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { SqlNamedParams } from '../types'
import { textResponse } from '../utils/mcp-response'
import {
  searchDefsEffective,
  type DefSearchResultRow,
} from '../repositories/defs-repo'

export interface SearchDefsOptions {
  query: string
  defType?: string
  mod?: string
  limit?: number
  /** 'effective' (default) = load-order winner only; 'all' = every mod version */
  dup?: 'effective' | 'all'
}

export function searchDefsImpl(
  db: Database,
  query: string,
  defType?: string,
  mod?: string,
  limit: number = 20,
  dup: 'effective' | 'all' = 'effective',
): { results: DefSearchResultRow[]; total: number } {
  const rows = searchDefsEffective(db, query, defType, mod, limit, dup)
  const total = rows[0]?.total ?? 0
  return { results: rows, total }
}

/** Registered as outputSchema for search_defs in server.ts. */
export const searchDefsOutputSchema = z.object({
  total: z.number(),
  results: z.array(
    z.object({
      defName: z.string(),
      defType: z.string(),
      label: z.string().nullable(),
      packageId: z.string(),
      versions: z.number(),
    }),
  ),
})

export type SearchDefsStructured = z.infer<typeof searchDefsOutputSchema>

export function searchDefs(
  db: Database,
  query: string,
  defType?: string,
  mod?: string,
  limit: number = 20,
  dup: 'effective' | 'all' = 'effective',
): ReturnType<typeof textResponse> & { structuredContent: SearchDefsStructured } {
  const { results, total } = searchDefsImpl(db, query, defType, mod, limit, dup)

  // every success result must carry structuredContent once an outputSchema is
  // registered — the SDK validates it before the result leaves the server
  const structuredContent: SearchDefsStructured = {
    total,
    results: results.map(({ defName, defType, label, packageId, versions }) => ({
      defName,
      defType,
      label,
      packageId,
      versions,
    })),
  }

  if (total === 0) {
    return {
      ...textResponse('No results found. Try a shorter keyword.'),
      structuredContent,
    }
  }

  // every line carries the owning [packageId]
  const formatted = results
    .map(r => {
      const labelStr = r.label ? ` (label: "${r.label}")` : ''
      const overridden =
        dup === 'effective' && r.versions > 1 ? ` (+${r.versions - 1} overridden)` : ''
      return `[${r.packageId}] [${r.defType}] ${r.defName}${labelStr}${overridden}`
    })
    .join('\n')

  let finalOutput = formatted

  if (results.length < total) {
    finalOutput += `\n\n[TRUNCATED] Showing ${results.length}/${total} results.`
    finalOutput += '\n(Tip: Increase `limit` or refine query.)'
  }

  return { ...textResponse(finalOutput), structuredContent }
}
