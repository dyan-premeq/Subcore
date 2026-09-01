import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { ModSource, ModsRow } from '../types'
import { textResponse } from '../utils/mcp-response'
import { listProfileMods } from '../repositories/mods-repo'
import { parseJsonArray } from '../utils/json'

const DETAIL_PAGE_SIZE = 20

export interface ListModsOptions {
  detail?: boolean
  page?: number
}

/** Registered as outputSchema for list_mods in server.ts. */
export const listModsOutputSchema = z.object({
  total: z.number(),
  results: z.array(
    z.object({
      packageId: z.string(),
      name: z.string().nullable(),
      source: z.enum(['official', 'mod']),
      loadOrder: z.number(),
      // overview mode omits these; detail mode fills them for the current page
      activeFolders: z.array(z.string()).optional(),
      warnings: z.array(z.string()).optional(),
      assetPath: z.string().optional(),
    }),
  ),
})

export type ListModsStructured = z.infer<typeof listModsOutputSchema>

export function listMods(
  db: Database,
  options: ListModsOptions = {},
): ReturnType<typeof textResponse> & { structuredContent: ListModsStructured } {
  const rows = listProfileMods(db)

  // every success result must carry structuredContent once an outputSchema is
  // registered — the SDK validates it before the result leaves the server
  if (rows.length === 0) {
    return {
      ...textResponse(
        'No mods found. Vanilla-only builds have no mods table entries unless ' +
          'import-mods has been run (base packages appear after `bun run build`).',
      ),
      structuredContent: { total: 0, results: [] },
    }
  }

  return options.detail ? detailResponse(rows, options.page ?? 1) : overviewResponse(rows)
}

function overviewResponse(rows: ModsRow[]) {
  const structuredContent: ListModsStructured = {
    total: rows.length,
    results: rows.map(({ packageId, name, source, loadOrder }) => ({
      packageId,
      name,
      source: foldSource(source),
      loadOrder,
    })),
  }

  const lines = [
    `Mods (${rows.length}):`,
    ...rows.map(overviewLine),
    'Use detail:true (with page) for folders/assets/full warnings.',
  ]
  return { ...textResponse(lines.join('\n')), structuredContent }
}

function detailResponse(rows: ModsRow[], page: number) {
  const pageCount = Math.ceil(rows.length / DETAIL_PAGE_SIZE)
  if (page > pageCount) {
    return {
      ...textResponse(`page ${page} out of range (1-${pageCount})`),
      structuredContent: { total: rows.length, results: [] },
    }
  }

  const pageRows = rows.slice((page - 1) * DETAIL_PAGE_SIZE, page * DETAIL_PAGE_SIZE)
  const structuredContent: ListModsStructured = {
    total: rows.length,
    results: pageRows.map(fullRow),
  }

  const lines = [
    `Mods (${rows.length}):`,
    ...pageRows.flatMap(detailLines),
    `page ${page}/${pageCount}`,
  ]
  return { ...textResponse(lines.join('\n')), structuredContent }
}

function foldSource(source: ModSource): 'official' | 'mod' {
  return source === 'builtin' || source === 'dlc' ? 'official' : 'mod'
}

function overviewLine(row: ModsRow): string {
  const order = row.loadOrder >= 0 ? String(row.loadOrder) : '-'
  const name = row.name ?? '(unnamed)'
  const warnings = parseJsonArray(row.warnings ?? '[]', String)
  const warn = warnings.length > 0 ? ` ⚠${warnings.length}` : ''
  return `[${order}] ${row.packageId} — ${name} (${foldSource(row.source)})${warn}`
}

function detailLines(row: ModsRow): string[] {
  const lines = [overviewLine(row)]

  const folders = parseJsonArray(row.activeFolders ?? '[]', String)
  if (folders.length > 0) lines.push(`  folders: ${folders.join(', ')}`)

  if (row.assetPath) lines.push(`  assets: ${row.assetPath}`)

  const warnings = parseJsonArray(row.warnings ?? '[]', String)
  if (warnings.length > 0) {
    lines.push('  warnings:')
    for (const warning of warnings) lines.push(`    - ${warning}`)
  }

  return lines
}

function fullRow(row: ModsRow) {
  return {
    packageId: row.packageId,
    name: row.name,
    source: foldSource(row.source),
    loadOrder: row.loadOrder,
    activeFolders: parseJsonArray(row.activeFolders ?? '[]', String),
    warnings: parseJsonArray(row.warnings ?? '[]', String),
    assetPath: row.assetPath,
  }
}
