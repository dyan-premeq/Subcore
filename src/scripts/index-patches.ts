import type { Database } from 'bun:sqlite'
import type { Def, ModsManifest } from '../types'
import {
  defsPath,
  indexDbPath,
  modsAssetPath,
  modsManifestPath,
  patchesPath,
} from '../utils/env'
import { parseDefNodes } from '../utils/def-xml'
import { processDefs, type DefEntry } from '../utils/def-resolver'
import { withIndexWriter } from '../db/writer'
import { packageIdNoSuffix } from '../utils/mod-discovery'
import type { XmlConditions } from '../utils/xml-conditions'
import { countMods, listInProfileModNames, listInProfilePackageIds } from '../repositories/mods-repo'
import { readManifest } from '../utils/manifest'
import { scanModFiles, scanVanillaFiles, type AssetFileRef } from '../utils/asset-scan'
import {
  PatchEvaluator,
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
  await withIndexWriter(dbPath, db => indexPatches(
    db, defsSourcePath, patchesSourcePath, modsSourcePath, readManifest(manifestPath), opts,
  ))
}

export async function indexPatches(
  db: Database,
  defsSourcePath: string,
  patchesSourcePath: string,
  modsSourcePath: string,
  manifest: ModsManifest | null,
  opts: RebuildPatchesOptions = {},
  conditions?: XmlConditions,
  modRoot?: (assetPath: string) => string,
): Promise<void> {
  if (countMods(db) === 0) {
    throw new Error(
      'mods table is empty — run "bun run index:mods" first (or the full "bun run build").',
    )
  }

  // every "is it active" judgment runs against the dev profile
  const activePackageIds = new Set(listInProfilePackageIds(db).map(packageIdNoSuffix))
  const activeModNames = new Set(listInProfileModNames(db))

  const defRefs: AssetFileRef[] = []
  defRefs.push(...(await scanVanillaFiles(db, defsSourcePath, 'Defs')))
  defRefs.push(...scanModFiles(db, modsSourcePath, manifest, 'Defs', modRoot))

  const patchRefs: AssetFileRef[] = []
  patchRefs.push(...(await scanVanillaFiles(db, patchesSourcePath, 'Patches')))
  patchRefs.push(...scanModFiles(db, modsSourcePath, manifest, 'Patches', modRoot))
  console.error(`Collected ${patchRefs.length} patch files.`)

  if (patchRefs.length === 0) {
    db.run('DELETE FROM patch_ops')
    db.run('DELETE FROM patched_defs')
    console.error('No patch files found; patch_ops and patched_defs cleared.')
    return
  }

  // ① interpreter: unified tree + patch application (game order)
  console.error(`Building unified def tree from ${defRefs.length} files...`)
  const evaluator = new PatchEvaluator({ activeModNames, onFindMod: names => conditions?.findMod(names) })
  let defGroups: PatchedDefGroup[]
  let changedBy: Map<string, number[]>
  try {
    await evaluator.buildTree(defRefs)

    console.error('Applying patches...')
    if (opts.skipApply) {
      await evaluator.collectPatchMetadata(patchRefs)
    } else {
      await evaluator.applyPatches(patchRefs)
    }

    // persist patch_ops (search_patches stays usable in both modes)
    db.run('DELETE FROM patch_ops')
    replacePatchOps(db, evaluator.opRecords)

    const stats = evaluator.stats()
    console.error(
      `Patch ops: ${evaluator.opRecords.length} total — ` +
        Object.entries(stats)
          .filter(([, n]) => n > 0)
          .map(([status, n]) => `${status}: ${n}`)
          .join(', '),
    )

    if (opts.skipApply) {
      db.run('DELETE FROM patched_defs')
      console.error('--skip-patches: patched_defs left empty.')
      return
    }

    // ② JSON pipeline on the patched tree: parse → MayRequire prune →
    // inheritance re-resolution → patched_defs (M2 code reused verbatim)
    console.error('Resolving patched defs...')
    ;({ defGroups, changedBy } = evaluator.serialize())
  } finally {
    evaluator.dispose()
  }

  const flat: FlatPatchedDef[] = []
  let mayRequireSkipped = 0
  for (const group of defGroups) {
    // group order = tree order = (loadOrder, filePath, document order)
    const { nodes, skipped } = parseDefNodes(group.xml, activePackageIds, conditions)
    mayRequireSkipped += skipped
    for (const node of nodes) flat.push({ ...node, ...groupRef(group) })
  }
  if (mayRequireSkipped > 0) {
    console.error(
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
  console.error(
    `Build complete! ${evaluator.opRecords.length} patch ops, ${rows.size} patched defs written.`,
  )
}

function groupRef(group: PatchedDefGroup): Pick<FlatPatchedDef, 'modId' | 'loadOrder' | 'filePath'> {
  return { modId: group.modId, loadOrder: group.loadOrder, filePath: group.filePath }
}

if (import.meta.main) {
  const skipApply = process.argv.includes('--skip-patches')
  await rebuildPatchesIndex(indexDbPath, { skipApply })
}
