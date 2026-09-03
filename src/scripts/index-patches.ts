import { Database } from 'bun:sqlite'
import type { Def } from '../types'
import {
  defsPath,
  indexDbPath,
  modsAssetPath,
  modsManifestPath,
  patchesPath,
} from '../utils/env'
import { parser } from '../utils/xml-utils'
import { isMayRequireSatisfied, processDefs, type DefEntry } from '../utils/def-resolver'
import { ensureSchema } from '../db/schema'
import { countMods, listInProfileModNames, listInProfilePackageIds } from '../repositories/mods-repo'
import { readManifest } from '../utils/manifest'
import { scanModFiles, scanVanillaFiles, type AssetFileRef } from '../utils/asset-scan'
import {
  PatchEvaluator,
  PATCH_DEF_LOAD_ORDER,
  type PatchedDefGroup,
} from '../utils/patch-evaluator'
import {
  replacePatchOps,
  replacePatchedDefs,
  type PatchedDefInsertRow,
} from '../repositories/patches-repo'

interface FlatPatchedDef {
  def: Def
  defType: string
  modId: number
  loadOrder: number
  filePath: string
}

export interface RebuildPatchesOptions {
  /** parse patch metadata only; leave patched_defs empty */
  skipApply?: boolean
}

export async function rebuildPatchesIndex(
  dbPath = indexDbPath,
  opts: RebuildPatchesOptions = {},
  defsSourcePath = defsPath,
  patchesSourcePath = patchesPath,
  modsSourcePath = modsAssetPath,
  manifestPath = modsManifestPath,
): Promise<void> {
  console.log('Starting patch index build...')

  const db = new Database(dbPath)

  try {
    ensureSchema(db)

    if (countMods(db) === 0) {
      throw new Error(
        'mods table is empty — run "bun run index:mods" first (or the full "bun run build").',
      )
    }

    // every "is it active" judgment runs against the dev profile
    const activePackageIds = new Set(listInProfilePackageIds(db))
    const activeModNames = new Set(listInProfileModNames(db))
    const manifest = readManifest(manifestPath)

    const defRefs: AssetFileRef[] = []
    defRefs.push(...(await scanVanillaFiles(db, defsSourcePath, 'Defs')))
    defRefs.push(...scanModFiles(db, modsSourcePath, manifest, 'Defs'))

    const patchRefs: AssetFileRef[] = []
    patchRefs.push(...(await scanVanillaFiles(db, patchesSourcePath, 'Patches')))
    patchRefs.push(...scanModFiles(db, modsSourcePath, manifest, 'Patches'))
    console.log(`Collected ${patchRefs.length} patch files.`)

    if (patchRefs.length === 0) {
      db.run('DELETE FROM patch_ops')
      db.run('DELETE FROM patched_defs')
      console.log('No patch files found; patch_ops and patched_defs cleared.')
      return
    }

    // ① interpreter: unified tree + patch application (game order)
    console.log(`Building unified def tree from ${defRefs.length} files...`)
    const evaluator = new PatchEvaluator({ activeModNames })
    await evaluator.buildTree(defRefs)

    console.log('Applying patches...')
    if (opts.skipApply) {
      await evaluator.collectPatchMetadata(patchRefs)
    } else {
      await evaluator.applyPatches(patchRefs)
    }

    // persist patch_ops (search_patches stays usable in both modes)
    db.run('DELETE FROM patch_ops')
    replacePatchOps(db, evaluator.opRecords)

    const stats = evaluator.stats()
    console.log(
      `Patch ops: ${evaluator.opRecords.length} total — ` +
        Object.entries(stats)
          .filter(([, n]) => n > 0)
          .map(([status, n]) => `${status}: ${n}`)
          .join(', '),
    )

    if (opts.skipApply) {
      db.run('DELETE FROM patched_defs')
      console.log('--skip-patches: patched_defs left empty.')
      return
    }

    // ② JSON pipeline on the patched tree: parse → MayRequire prune →
    // inheritance re-resolution → patched_defs (M2 code reused verbatim)
    console.log('Resolving patched defs...')
    const { defGroups, changedBy } = evaluator.serialize()

    const flat: FlatPatchedDef[] = []
    let mayRequireSkipped = 0
    for (const group of defGroups) {
      // group order = tree order = (loadOrder, filePath, document order)
      const defsRoot = parser.parse(group.xml).Defs as Record<string, unknown> | undefined
      if (!defsRoot) continue

      for (const [defType, defsForType] of Object.entries(defsRoot)) {
        if (!Array.isArray(defsForType)) continue
        for (const def of defsForType as Def[]) {
          if (!def || typeof def !== 'object') continue
          if (
            !isMayRequireSatisfied(
              def['@_MayRequire'],
              def['@_MayRequireAnyOf'],
              activePackageIds,
            )
          ) {
            mayRequireSkipped++
            continue
          }
          flat.push({ def: Object.assign({ defType }, def), defType, ...groupRef(group) })
        }
      }
    }
    if (mayRequireSkipped > 0) {
      console.log(
        `Skipped ${mayRequireSkipped} patched defs whose MayRequire is not satisfied by the profile.`,
      )
    }

    const { resolved } = processDefs(
      flat.map(
        (entry): DefEntry => ({
          def: entry.def,
          defType: entry.defType,
          modId: entry.modId,
          loadOrder: entry.loadOrder,
        }),
      ),
    )

    // DefDatabase.AddAllInMods write order: rows arrive in (loadOrder × file ×
    // document) order, so later writes win; same-mod duplicate (defName,
    // defType) keeps the first occurrence (game: "...multiple...Skipping"),
    // patch-added defs carry PATCH_DEF_LOAD_ORDER and override everything
    const seenSameMod = new Set<string>()
    const rows = new Map<string, PatchedDefInsertRow>()
    flat.forEach((entry, index) => {
      const resolvedDef = resolved[index]
      if (!resolvedDef.defName) return // abstract templates etc.

      const sameModKey = `${entry.modId}|${entry.defType}|${resolvedDef.defName}`
      if (seenSameMod.has(sameModKey)) {
        console.warn(
          `[index-patches] duplicate patched def "${resolvedDef.defName}" (${entry.defType}) in mod ${entry.modId}; keeping the first occurrence`,
        )
        return
      }
      seenSameMod.add(sameModKey)

      rows.set(`${entry.defType}|${resolvedDef.defName}`, {
        defName: resolvedDef.defName,
        defType: entry.defType,
        payload: JSON.stringify(resolvedDef),
        changedBy: changedBy.get(resolvedDef.defName) ?? [],
      })
    })

    db.run('DELETE FROM patched_defs')
    replacePatchedDefs(db, [...rows.values()])
    console.log(
      `Build complete! ${evaluator.opRecords.length} patch ops, ${rows.size} patched defs written.`,
    )
  } finally {
    db.close()
  }
}

function groupRef(group: PatchedDefGroup): Pick<FlatPatchedDef, 'modId' | 'loadOrder' | 'filePath'> {
  return { modId: group.modId, loadOrder: group.loadOrder, filePath: group.filePath }
}

if (import.meta.main) {
  const skipApply = process.argv.includes('--skip-patches')
  await rebuildPatchesIndex(indexDbPath, { skipApply })
}
