import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { ModSource, ModsRow } from '../types'
import { textResponse } from '../utils/mcp-response'
import { listProfileMods } from '../repositories/mods-repo'
import { parseJsonArray } from '../utils/json'

export function listModsImpl(db: Database): ModsRow[] {
  return listProfileMods(db)
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
      activeFolders: z.array(z.string()),
      warnings: z.array(z.string()),
      assetPath: z.string(),
    }),
  ),
})

export type ListModsStructured = z.infer<typeof listModsOutputSchema>

export function listMods(
  db: Database,
): ReturnType<typeof textResponse> & { structuredContent: ListModsStructured } {
  const rows = listModsImpl(db)

  // every success result must carry structuredContent once an outputSchema is
  // registered — the SDK validates it before the result leaves the server
  const structuredContent: ListModsStructured = {
    total: rows.length,
    results: rows.map(row => ({
      packageId: row.packageId,
      name: row.name,
      source: foldSource(row.source),
      loadOrder: row.loadOrder,
      activeFolders: parseJsonArray(row.activeFolders ?? '[]', String),
      warnings: parseJsonArray(row.warnings ?? '[]', String),
      assetPath: row.assetPath,
    })),
  }

  if (rows.length === 0) {
    return {
      ...textResponse(
        'No mods found. Vanilla-only builds have no mods table entries unless ' +
          'import-mods has been run (base packages appear after `bun run build`).',
      ),
      structuredContent,
    }
  }

  const lines: string[] = [`Mods (${rows.length}):`]
  for (const row of rows) {
    lines.push(formatMod(row))
  }

  return { ...textResponse(lines.join('\n')), structuredContent }
}

function foldSource(source: ModSource): 'official' | 'mod' {
  return source === 'builtin' || source === 'dlc' ? 'official' : 'mod'
}

function formatMod(row: ModsRow): string {
  const parts: string[] = []

  const order = row.loadOrder >= 0 ? String(row.loadOrder) : '-'
  parts.push(`[${order}] ${row.packageId}`)
  parts.push(row.name ?? '(unnamed)')
  parts.push(`(${foldSource(row.source)})`)

  const folders = parseJsonArray(row.activeFolders ?? '[]', String)
  if (folders.length > 0) parts.push(`folders=${folders.join(',')}`)

  if (row.assetPath) parts.push(`assets=${row.assetPath}`)

  const warnings = parseJsonArray(row.warnings ?? '[]', String)
  if (warnings.length > 0) {
    parts.push(`warnings(${warnings.length}): ${warnings.slice(0, 2).join(' | ')}`)
    if (warnings.length > 2) parts.push(`  … +${warnings.length - 2} more`)
  }

  return parts.join(' ')
}
