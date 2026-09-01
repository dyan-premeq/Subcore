import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { textResponse } from '../utils/mcp-response'
import { PathSandbox } from '../utils/path-sandbox'
import { searchSourceImpl } from './search-source'
import { getDefDetailsRows } from '../repositories/defs-repo'
import { searchPatchOps } from '../repositories/patches-repo'
import { searchHarmonyPatches, type HarmonySearchRow } from '../repositories/harmony-repo'
import { parseJsonArray } from '../utils/json'

/** Per-group display cap; the rest collapses into a search_source hint. */
const MAX_HITS_PER_GROUP = 10
/** Row cap for the three DB lookups (matches search_patches/search_harmony max). */
const MAX_DB_ROWS = 200

/** Registered as outputSchema for find_refs in server.ts. */
export const findRefsOutputSchema = z.object({
  defs: z.array(
    z.object({
      defType: z.string(),
      packageId: z.string(),
      loadOrder: z.number(),
      filePath: z.string().nullable(),
      effective: z.boolean(),
    }),
  ),
  patches: z.array(
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
  harmony: z.array(
    z.object({
      packageId: z.string().nullable(),
      filePath: z.string(),
      patchClass: z.string().nullable(),
      targetType: z.string().nullable(),
      targetMethod: z.string().nullable(),
      prefix: z.boolean(),
      postfix: z.boolean(),
      transpiler: z.boolean(),
      finalizer: z.boolean(),
    }),
  ),
  sourceGroups: z.array(
    z.object({
      scope: z.string(),
      total: z.number(),
      hits: z.array(
        z.object({ file: z.string(), line: z.number(), text: z.string() }),
      ),
    }),
  ),
})

export type FindRefsStructured = z.infer<typeof findRefsOutputSchema>

/**
 * Exhaustive reference lookup for one exact identifier: full-text source
 * matches grouped by layer, plus the three indexed reverse lookups (defs,
 * patch ops, harmony patches). Everything is delegated to existing queries —
 * no new index, no scope-narrowing options (exhaustiveness is the point).
 */
export async function findRefs(
  db: Database,
  sandbox: PathSandbox,
  name: string,
): Promise<ReturnType<typeof textResponse> & { structuredContent: FindRefsStructured }> {
  const defs = queryDefs(db, name)
  const patches = queryPatches(db, name)
  const harmony = queryHarmony(db, name)
  const { groups: sourceGroups, truncated } = await querySource(sandbox, name)

  const structuredContent: FindRefsStructured = {
    defs,
    patches,
    harmony,
    sourceGroups: sourceGroups.map(({ group, ...rest }) => rest),
  }

  if (
    defs.length === 0 &&
    patches.length === 0 &&
    harmony.length === 0 &&
    sourceGroups.length === 0
  ) {
    return {
      ...textResponse(`No references to "${name}" found in any layer.`),
      structuredContent,
    }
  }

  const sections: string[] = [`References to "${name}":`]

  if (sourceGroups.length > 0) {
    const lines: string[] = ['Full-text source matches:']
    for (const group of sourceGroups) {
      lines.push(`[${group.group}] ${group.total} ${group.total === 1 ? 'match' : 'matches'}`)
      for (const hit of group.hits) {
        lines.push(`  ${hit.file}:${hit.line}: ${hit.text}`)
      }
      if (group.total > group.hits.length) {
        lines.push(
          `  ... use search_source with scope:'${group.scope}' to see all ${group.total} matches`,
        )
      }
    }
    if (truncated) {
      lines.push(
        '[TRUNCATED] Full-text output exceeded the 100KB search limit; matches above are partial — drill down with search_source per scope.',
      )
    }
    sections.push(lines.join('\n'))
  }

  if (defs.length > 0) {
    sections.push(renderDefs(defs))
  }

  if (patches.length > 0) {
    sections.push(renderPatches(patches))
  }

  if (harmony.length > 0) {
    sections.push(renderHarmony(harmony))
  }

  return {
    ...textResponse(sections.join('\n\n')),
    structuredContent,
  }
}

// #region quadrant 1: full-text source matches

interface SourceHit {
  file: string
  line: number
  text: string
}

/** Internal shape; structuredContent drops `group` (the header label). */
interface SourceGroup {
  group: string
  scope: string
  total: number
  hits: SourceHit[]
}

async function querySource(
  sandbox: PathSandbox,
  name: string,
): Promise<{ groups: SourceGroup[]; truncated: boolean }> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const { output, exceededOutputLimit } = await searchSourceImpl(
    sandbox,
    `\\b${escaped}\\b`,
    false,
    undefined,
    { scope: 'all' },
  )

  const byGroup = new Map<string, SourceHit[]>()
  for (const hit of parseRgHeadingOutput(output)) {
    const group = groupKey(hit.file)
    const list = byGroup.get(group)
    if (list) list.push(hit)
    else byGroup.set(group, [hit])
  }

  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, hits]) => {
      // Languages/ (DefInjected etc.) hits rank last so the per-group sample
      // shows defs, patches and code before translation noise.
      const sorted = hits.sort(
        (a, b) =>
          Number(a.file.includes('/Languages/')) -
            Number(b.file.includes('/Languages/')) ||
          (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line),
      )
      return {
        group,
        scope: groupScope(group),
        total: sorted.length,
        hits: sorted.slice(0, MAX_HITS_PER_GROUP),
      }
    })

  return { groups, truncated: exceededOutputLimit }
}

/**
 * rg runs with --heading: a file path line starts each block, match lines are
 * `<lineNum>:<content>`, blank lines separate blocks. Paths are normalized to
 * forward slashes without the './' prefix.
 */
function parseRgHeadingOutput(output: string): SourceHit[] {
  const hits: SourceHit[] = []
  let file = ''
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue
    const match = /^(\d+):(.*)$/.exec(line)
    if (match && file !== '') {
      hits.push({ file, line: Number(match[1]), text: match[2] })
    } else {
      file = normalizePath(line)
    }
  }
  return hits
}

function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, '/')
  return unified.startsWith('./') ? unified.slice(2) : unified
}

/** Layer group for a sandbox-relative path: Defs/, Source/, Mods/<pkg>, or itself. */
function groupKey(file: string): string {
  if (file.startsWith('Defs/')) return 'Defs/'
  if (file.startsWith('Source/')) return 'Source/'
  if (file.startsWith('Mods/')) {
    const rest = file.slice('Mods/'.length)
    const slash = rest.indexOf('/')
    return slash === -1 ? `Mods/${rest}` : `Mods/${rest.slice(0, slash)}`
  }
  return file
}

function groupRank(group: string): number {
  if (group === 'Defs/') return 0
  if (group === 'Source/') return 1
  if (group.startsWith('Mods/')) return 2
  return 3
}

/** search_source scope that drills into this group. */
function groupScope(group: string): string {
  if (group === 'Defs/' || group === 'Source/') return 'vanilla'
  if (group.startsWith('Mods/')) return group.slice('Mods/'.length)
  return 'all'
}

// #endregion

// #region quadrant 2: def definitions (exact defName, every defining mod)

function queryDefs(db: Database, name: string): FindRefsStructured['defs'] {
  const rows = getDefDetailsRows(db, name, undefined, { dup: 'all' })
  const maxLoad = new Map<string, number>()
  for (const row of rows) {
    maxLoad.set(row.defType, Math.max(maxLoad.get(row.defType) ?? row.loadOrder, row.loadOrder))
  }
  return rows.map(row => ({
    defType: row.defType,
    packageId: row.packageId,
    loadOrder: row.loadOrder,
    filePath: row.filePath,
    effective: row.loadOrder === maxLoad.get(row.defType),
  }))
}

function renderDefs(defs: FindRefsStructured['defs']): string {
  const byType = new Map<string, FindRefsStructured['defs']>()
  for (const def of defs) {
    const list = byType.get(def.defType)
    if (list) list.push(def)
    else byType.set(def.defType, [def])
  }

  const lines: string[] = ['Def definitions:']
  for (const [defType, versions] of byType) {
    const chain = versions.map(v => v.packageId).join(' → ')
    const effective = versions.find(v => v.effective)
    lines.push(
      versions.length > 1
        ? `  ${defType} — defined by ${chain}, effective: ${effective?.packageId}`
        : `  ${defType} — defined by ${chain} (effective)`,
    )
  }
  return lines.join('\n')
}

// #endregion

// #region quadrant 3: XML patch operations

function queryPatches(db: Database, name: string): FindRefsStructured['patches'] {
  return searchPatchOps(db, { defName: name }, MAX_DB_ROWS).map(row => ({
    packageId: row.packageId,
    filePath: row.filePath,
    seq: row.seq,
    opClass: row.opClass,
    xpath: row.xpath,
    targetDefs: parseJsonArray(row.targetDefs, String),
    status: row.status,
  }))
}

function renderPatches(patches: FindRefsStructured['patches']): string {
  const lines = patches.map(patch => {
    const xpath = patch.xpath ? ` ${patch.xpath}` : ''
    const targets =
      patch.targetDefs.length > 0 ? ` → ${patch.targetDefs.join(', ')}` : ''
    return `  [${patch.packageId}] ${patch.filePath} #${patch.seq} ${patch.opClass} (${patch.status})${xpath}${targets}`
  })
  return ['XML patch operations:', ...lines].join('\n')
}

// #endregion

// #region quadrant 4: harmony patches (targetType OR targetMethod)

function queryHarmony(db: Database, name: string): FindRefsStructured['harmony'] {
  // the repo query ANDs its filters, so query twice and merge on row identity
  const seen = new Set<string>()
  const rows: HarmonySearchRow[] = []
  for (const row of [
    ...searchHarmonyPatches(db, { targetType: name }, MAX_DB_ROWS),
    ...searchHarmonyPatches(db, { targetMethod: name }, MAX_DB_ROWS),
  ]) {
    const key = `${row.modId}|${row.filePath}|${row.patchClass}|${row.targetType}|${row.targetMethod}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  return rows.map(row => ({
    packageId: row.packageId,
    filePath: row.filePath,
    patchClass: row.patchClass,
    targetType: row.targetType,
    targetMethod: row.targetMethod,
    prefix: row.prefix === 1,
    postfix: row.postfix === 1,
    transpiler: row.transpiler === 1,
    finalizer: row.finalizer === 1,
  }))
}

function renderHarmony(harmony: FindRefsStructured['harmony']): string {
  const lines = harmony.map(patch => {
    const who = patch.patchClass ?? '(unknown class)'
    const target = patch.targetMethod
      ? `${patch.targetType}.${patch.targetMethod}`
      : patch.targetType ?? '(unknown target)'
    const kinds = [
      patch.prefix && 'prefix',
      patch.postfix && 'postfix',
      patch.transpiler && 'transpiler',
      patch.finalizer && 'finalizer',
    ].filter(Boolean).join(' ')
    const origin = patch.packageId ?? 'vanilla'
    return `  [${origin}] ${who} -> ${target}${kinds ? ` [${kinds}]` : ''} ${patch.filePath}`
  })
  return ['Harmony patches:', ...lines].join('\n')
}

// #endregion
