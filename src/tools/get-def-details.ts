import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { builder } from '../utils/xml-utils'
import { textResponse } from '../utils/mcp-response'
import {
  getDefDetailsRows,
  getDefLineage,
  type DefDetailResultRow,
  type DefLineageRow,
} from '../repositories/defs-repo'

export type DefDetailsView = 'merged' | 'raw'

export interface GetDefDetailsOptions {
  view?: DefDetailsView
  mod?: string
  /** 'effective' = load-order winner; 'all' = every defining mod */
  dup?: 'effective' | 'all'
}

/** Registered as outputSchema for get_def_details in server.ts. */
export const defDetailsOutputSchema = z.object({
  lineage: z.array(
    z.object({ packageId: z.string(), loadOrder: z.number() }),
  ),
  defs: z.array(
    z.object({
      defType: z.string(),
      packageId: z.string(),
      loadOrder: z.number(),
      filePath: z.string().nullable(),
      xml: z.string(),
    }),
  ),
})

export type DefDetailsStructured = z.infer<typeof defDetailsOutputSchema>

type GetDefDetailsResponse = ReturnType<typeof textResponse> & {
  isError?: boolean
  structuredContent?: DefDetailsStructured
}

export function getDefDetails(
  db: Database,
  defName: string,
  defType?: string,
  options: GetDefDetailsOptions = {},
): GetDefDetailsResponse {
  const { view = 'merged', mod, dup = 'effective' } = options

  const rows = getDefDetailsRows(db, defName, defType, { view, mod, dup })

  if (rows.length === 0) {
    const errorText = `Def \`${defName}\`${
      defType ? ` (type: ${defType})` : ''
    } not found. Try using 'search_source' to verify the exact name.`

    return {
      isError: true,
      ...textResponse(errorText),
    }
  }

  const sections: string[] = []

  const lineage = getDefLineage(db, defName, defType)
  const lineageText = formatLineage(lineage)
  if (lineageText) {
    // lineage is inherently global — the game resolves overrides across the
    // full load order, so the mod filter never narrows it (only the sections)
    sections.push(
      mod
        ? `${lineageText}\n(note: lineage is the full global override chain; the mod filter only narrows the XML sections below.)`
        : lineageText,
    )
  }

  const entries = rows.map(row => ({ row, xml: xmlOf(row) }))

  if (dup === 'all') {
    // one section per defining mod, ordered along the override chain
    const maxLoadOrder = Math.max(...lineage.map(l => l.loadOrder))
    for (const { row, xml } of entries) {
      const effective = row.loadOrder === maxLoadOrder ? ', effective' : ''
      sections.push(
        `--- [${row.packageId}] (loadOrder ${row.loadOrder}${effective}) ---\n${xml}`,
      )
    }
  } else {
    sections.push(entries.map(e => e.xml).join('\n\n'))
  }

  return {
    ...textResponse(sections.join('\n\n')),
    structuredContent: {
      lineage: lineage.map(({ packageId, loadOrder }) => ({ packageId, loadOrder })),
      defs: entries.map(({ row, xml }) => ({
        defType: row.defType,
        packageId: row.packageId,
        loadOrder: row.loadOrder,
        filePath: row.filePath,
        xml,
      })),
    },
  }
}

function xmlOf(row: DefDetailResultRow): string {
  const obj = JSON.parse(row.payload)
  delete obj.defType
  return builder.build({ [row.defType]: obj })
}

/**
 * Lineage line: `defined by A → overridden by B → effective: C`.
 */
function formatLineage(rows: DefLineageRow[]): string {
  if (rows.length === 0) return ''
  const first = rows[0]!
  const effective = rows[rows.length - 1]!
  if (rows.length === 1) {
    return `Lineage: defined by ${first.packageId} (effective)`
  }
  const parts = [`defined by ${first.packageId}`]
  for (const row of rows.slice(1, -1)) parts.push(`overridden by ${row.packageId}`)
  parts.push(`effective: ${effective.packageId}`)
  return `Lineage: ${parts.join(' → ')}`
}
