import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { textResponse } from '../utils/mcp-response'
import { searchHarmonyPatches, type HarmonySearchRow } from '../repositories/harmony-repo'

export interface SearchHarmonyOptions {
  targetType?: string
  targetMethod?: string
  packageId?: string
  limit?: number
}

/** Registered as outputSchema for search_harmony in server.ts. */
export const searchHarmonyOutputSchema = z.object({
  total: z.number(),
  results: z.array(
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
})

export type SearchHarmonyStructured = z.infer<typeof searchHarmonyOutputSchema>

export function searchHarmony(db: Database, options: SearchHarmonyOptions = {}): ReturnType<
  typeof textResponse
> & { structuredContent: SearchHarmonyStructured } {
  const results = searchHarmonyPatches(
    db,
    {
      targetType: options.targetType,
      targetMethod: options.targetMethod,
      packageId: options.packageId,
    },
    options.limit ?? 50,
  )
  const total = results[0]?.total ?? 0

  const structuredContent: SearchHarmonyStructured = {
    total,
    results: results.map(formatRow),
  }

  if (total === 0) {
    const hint = options.targetType || options.targetMethod
      ? ' Tip: targetType/targetMethod match exactly (C# names are case-sensitive); try search_source for looser exploration.'
      : ''
    return {
      ...textResponse(`No harmony patches found.${hint}`),
      structuredContent,
    }
  }

  const lines = results.map(row => {
    const origin = row.packageId ?? 'vanilla'
    const kinds = formatKinds(row)
    return `[${origin}] ${describePatch(row)}${kinds ? ` [${kinds}]` : ''} ${row.filePath}`
  })

  const runtimeNote = results.some(
    row => row.targetType === 'dynamic' || row.targetType === '*Assembly*',
  )
    ? '\n[dynamic/*Assembly* = target resolved at runtime (TargetMethod/PatchAll/manual patching) — read the mod source for details.]'
    : ''

  return {
    ...textResponse(
      `Harmony patches (${total}${total > results.length ? `, showing ${results.length}` : ''}):\n` +
        lines.join('\n') +
        runtimeNote,
    ),
    structuredContent,
  }
}

function formatRow(row: HarmonySearchRow): SearchHarmonyStructured['results'][number] {
  return {
    packageId: row.packageId,
    filePath: row.filePath,
    patchClass: row.patchClass,
    targetType: row.targetType,
    targetMethod: row.targetMethod,
    prefix: row.prefix === 1,
    postfix: row.postfix === 1,
    transpiler: row.transpiler === 1,
    finalizer: row.finalizer === 1,
  }
}

function describePatch(row: HarmonySearchRow): string {
  const who = row.patchClass ?? '(unknown class)'
  const target = row.targetMethod
    ? `${row.targetType}.${row.targetMethod}`
    : row.targetType ?? '(unknown target)'
  return `${who} -> ${target}`
}

function formatKinds(row: HarmonySearchRow): string {
  const kinds: string[] = []
  if (row.prefix) kinds.push('prefix')
  if (row.postfix) kinds.push('postfix')
  if (row.transpiler) kinds.push('transpiler')
  if (row.finalizer) kinds.push('finalizer')
  return kinds.join(' ')
}
