import type { Database } from 'bun:sqlite'
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
}

export function searchDefsImpl(
  db: Database,
  query: string,
  defType?: string,
  mod?: string,
  limit: number = 20,
): { results: DefSearchResultRow[]; total: number } {
  const rows = searchDefsEffective(db, query, defType, mod, limit)
  const total = rows[0]?.total ?? 0
  return { results: rows, total }
}

export function searchDefs(
  db: Database,
  query: string,
  defType?: string,
  mod?: string,
  limit: number = 20,
) {
  const { results, total } = searchDefsImpl(db, query, defType, mod, limit)

  if (total === 0) {
    return textResponse('No results found. Try a shorter keyword.')
  }

  // every line carries the owning [packageId]
  const formatted = results
    .map(r => {
      const labelStr = r.label ? ` (label: "${r.label}")` : ''
      const overridden = r.versions > 1 ? ` (+${r.versions - 1} overridden)` : ''
      return `[${r.packageId}] [${r.defType}] ${r.defName}${labelStr}${overridden}`
    })
    .join('\n')

  let finalOutput = formatted

  if (results.length < total) {
    finalOutput += `\n\n[TRUNCATED] Showing ${results.length}/${total} results.`
    finalOutput += '\n(Tip: Increase `limit` or refine query.)'
  }

  return textResponse(finalOutput)
}
