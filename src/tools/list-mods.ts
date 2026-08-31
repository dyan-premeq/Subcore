import type { Database } from 'bun:sqlite'
import type { ModDependency, ModsRow } from '../types'
import { textResponse } from '../utils/mcp-response'
import { listMods as listModsRows } from '../repositories/mods-repo'
import { parseJsonArray } from '../utils/json'

export interface ListModsFilter {
  inProfile?: boolean
  playerActive?: boolean
}

export function listModsImpl(db: Database, filter: ListModsFilter = {}): ModsRow[] {
  return listModsRows(db, filter)
}

export function listMods(db: Database, filter: ListModsFilter = {}) {
  const rows = listModsImpl(db, filter)

  if (rows.length === 0) {
    return textResponse(
      'No mods found. Vanilla-only builds have no mods table entries unless ' +
        'import-mods has been run (base packages appear after `bun run build`).',
    )
  }

  // dependency satisfaction is evaluated against everything indexed
  const indexedIds = new Set(rows.map(row => row.packageId))

  const inProfile = rows.filter(row => row.inProfile === 1)
  const notInProfile = rows.filter(row => row.inProfile !== 1)

  const lines: string[] = [`Mods (${inProfile.length} in profile):`]
  for (const row of inProfile) {
    lines.push(formatMod(row, indexedIds))
  }

  if (notInProfile.length > 0 && !filter.inProfile) {
    lines.push('', `Discovered but not in profile (${notInProfile.length}, metadata only):`)
    for (const row of notInProfile) {
      lines.push(formatMod(row, indexedIds))
    }
  }

  return textResponse(lines.join('\n'))
}

function formatMod(row: ModsRow, indexedIds: Set<string>): string {
  const parts: string[] = []

  const order = row.loadOrder >= 0 ? String(row.loadOrder) : '-'
  parts.push(`[${order}] ${row.packageId}`)
  parts.push(row.name ?? '(unnamed)')

  const tags: string[] = [row.source]
  if (row.inProfile === 1) tags.push('in-profile')
  else tags.push('not-in-profile')
  if (row.playerActive === 1) tags.push('player-active')

  const deps = dependencyStatus(row.dependencies, indexedIds)
  if (deps) tags.push(deps)

  const versions = parseJsonArray(row.supportedVersions ?? '[]', String)
  if (versions.length > 0) {
    tags.push(`v${versions.slice(0, 3).join(', v')}${versions.length > 3 ? '+…' : ''}`)
  }

  parts.push(`(${tags.join('; ')})`)

  const warnings = parseJsonArray(row.warnings ?? '[]', String)
  if (warnings.length > 0) {
    parts.push(`warnings(${warnings.length}): ${warnings.slice(0, 2).join(' | ')}`)
    if (warnings.length > 2) parts.push(`  … +${warnings.length - 2} more`)
  }

  return parts.join(' ')
}

function dependencyStatus(
  dependenciesJson: string | null,
  indexedIds: Set<string>,
): string | null {
  const deps = parseDependencies(dependenciesJson)
  if (deps.length === 0) return null
  const missing = deps
    .filter(dep => !indexedIds.has(dep.packageId.split('|')[0]))
    .map(dep => dep.packageId)
  return missing.length === 0 ? 'deps: ok' : `deps: missing ${missing.join(', ')}`
}

function parseDependencies(json: string | null): ModDependency[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
