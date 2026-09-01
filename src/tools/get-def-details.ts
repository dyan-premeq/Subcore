import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { buildXml } from '../utils/xml-utils'
import { textResponse } from '../utils/mcp-response'
import {
  getDefDetailsRows,
  getDefLineage,
  searchDefsEffective,
  type DefDetailResultRow,
  type DefLineageRow,
} from '../repositories/defs-repo'
import { getPatchedDefs, getPackageIdMap } from '../repositories/patches-repo'
import { parseJsonArray } from '../utils/json'

export type DefDetailsView = 'merged' | 'raw' | 'patched'

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
      patchedBy: z.array(z.string()).optional(),
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

  if (view === 'patched') {
    return getPatchedView(db, defName, defType)
  }

  const rows = getDefDetailsRows(db, defName, defType, { view, mod, dup })

  if (rows.length === 0) {
    let errorText = `Def \`${defName}\`${
      defType ? ` (type: ${defType})` : ''
    } not found. Try using 'search_source' to verify the exact name.`

    // did-you-mean: LIKE over defName/label, defType filter relaxed (R6c)
    const candidates = searchDefsEffective(db, defName, undefined, undefined, 5)
    if (candidates.length > 0) {
      const suggestions = candidates
        .map(c => `${c.defName} (${c.defType}, ${c.packageId})`)
        .join(', ')
      errorText += `\nDid you mean: ${suggestions}`
    }

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
  return buildXml({ [row.defType]: obj })
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

/**
 * view=patched: the def as the game actually loads it — patches applied, then
 * inheritance re-resolved. Falls back to the merged view (with a note) when
 * the patched_defs table has no row (def unpatched, MayRequire-pruned, or
 * the index was built with --skip-patches).
 */
function getPatchedView(
  db: Database,
  defName: string,
  defType?: string,
): GetDefDetailsResponse {
  const patched = getPatchedDefs(db, defName, defType)

  if (patched.length === 0) {
    const fallback = getDefDetails(db, defName, defType, { view: 'merged' })
    if (fallback.isError) return fallback
    return {
      ...fallback,
      ...textResponse(
        `Patched view has no row for \`${defName}\`${
          defType ? ` (${defType})` : ''
        } (unpatched, MayRequire-pruned, or built with --skip-patches) — showing the merged view instead:\n\n${
          fallback.content[0]!.text
        }`,
      ),
    }
  }

  const packageIds = getPackageIdMap(db)
  const lineage = getDefLineage(db, defName, defType)
  const lineageText = formatLineage(lineage)

  const sections: string[] = []
  if (lineageText) sections.push(lineageText)

  const defs: DefDetailsStructured['defs'] = []
  for (const row of patched) {
    const changedBy = parseJsonArray(row.changedBy, Number).map(
      modId => packageIds.get(modId) ?? `modId:${modId}`,
    )
    const changedText =
      changedBy.length > 0
        ? `Patched by: ${[...new Set(changedBy)].join(', ')}`
        : 'Patched by: (no evaluated patch touched this def)'
    const xml = xmlOfPayload(row.payload, row.defType)
    sections.push(`${changedText}\n${xml}`)
    defs.push({
      defType: row.defType,
      packageId: lineage.at(-1)?.packageId ?? 'patches',
      loadOrder: lineage.at(-1)?.loadOrder ?? -1,
      filePath: lineage.at(-1)?.filePath ?? null,
      xml,
      patchedBy: [...new Set(changedBy)],
    })
  }

  return {
    ...textResponse(sections.join('\n\n')),
    structuredContent: {
      lineage: lineage.map(({ packageId, loadOrder }) => ({ packageId, loadOrder })),
      defs,
    },
  }
}

function xmlOfPayload(payload: string, defType: string): string {
  const obj = JSON.parse(payload)
  delete obj.defType
  return buildXml({ [defType]: obj })
}

