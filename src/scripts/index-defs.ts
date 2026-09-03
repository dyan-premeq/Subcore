import { file } from 'bun'
import { Database } from 'bun:sqlite'
import type { Def } from '../types'
import { defsPath, indexDbPath, modsAssetPath, modsManifestPath } from '../utils/env'
import { parser } from '../utils/xml-utils'
import {
  isMayRequireSatisfied,
  processDefs,
  type DefEntry,
} from '../utils/def-resolver'
import { ensureSchema } from '../db/schema'
import {
  replaceDefNames,
  replaceDefs,
  type DefInsertRow,
} from '../repositories/defs-repo'
import {
  countMods,
  listInProfilePackageIds,
} from '../repositories/mods-repo'
import { readManifest } from '../utils/manifest'
import { scanModFiles, scanVanillaFiles, type AssetFileRef } from '../utils/asset-scan'
import { compareStrings } from '../utils/compare'

type DefFileRef = AssetFileRef

interface FlatDef {
  def: Def
  defType: string
  ref: DefFileRef
}

export async function rebuildDefsIndex(
  dbPath = indexDbPath,
  defsSourcePath = defsPath,
  modsSourcePath = modsAssetPath,
  manifestPath = modsManifestPath,
): Promise<void> {
  console.log('Starting build process...')

  const db = new Database(dbPath)

  try {
    ensureSchema(db)

    // 1. mods (index:mods runs first in the build chain and fills the table)
    if (countMods(db) === 0) {
      throw new Error(
        'mods table is empty — run "bun run index:mods" first (or the full "bun run build").',
      )
    }

    // 2. collect def file refs
    // MayRequire is evaluated against the dev profile:
    // the profile is the single source of truth for what is "active"
    const activePackageIds = new Set(listInProfilePackageIds(db))
    const manifest = readManifest(manifestPath)
    const refs: DefFileRef[] = []
    refs.push(...(await scanVanillaFiles(db, defsSourcePath, 'Defs')))
    refs.push(...scanModFiles(db, modsSourcePath, manifest, 'Defs'))
    console.log(`Collected ${refs.length} def files.`)

    // 3. parse & flatten (MayRequire-unsatisfied defs are not loaded by the
    // game at all — skip them here so they neither index nor register @Names)
    console.log('Parsing files...')
    const flat: FlatDef[] = []
    let mayRequireSkipped = 0
    await Promise.all(
      refs.map(async ref => {
        const xml = await file(ref.absPath).text()
        const defsRoot = parser.parse(xml).Defs as Record<string, unknown> | undefined
        if (!defsRoot) return

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
            flat.push({ def: Object.assign({ defType }, def), defType, ref })
          }
        }
      }),
    )
    if (mayRequireSkipped > 0) {
      console.log(
        `Skipped ${mayRequireSkipped} defs whose MayRequire is not satisfied by the profile.`,
      )
    }

    // 4. resolve inheritance (game XmlInheritance semantics). The sort
    // keeps same-mod def dedupe deterministic ("first file wins"); the
    // resolver itself works from explicit load orders, not input order.
    console.log(`Resolving inheritance for ${flat.length} defs...`)
    flat.sort(
      (a, b) =>
        a.ref.loadOrder - b.ref.loadOrder ||
        compareStrings(a.ref.filePath, b.ref.filePath),
    )
    const entries: DefEntry[] = flat.map(entry => ({
      def: entry.def,
      defType: entry.defType,
      modId: entry.ref.modId,
      loadOrder: entry.ref.loadOrder,
    }))
    const { resolved: mergedDefs, nameRegistry, issues } = processDefs(entries)
    for (const issue of issues) {
      console.warn(`[def-resolver] ${issue.kind}: ${issue.detail}`)
    }

    // 5. write (all versions kept; effective = highest loadOrder)
    console.log('Writing defs to db...')
    db.run('DELETE FROM defs')
    // patched_defs was evaluated against the old tree — drop it rather than
    // serve stale payloads (the patched view falls back to merged when empty)
    db.run('DELETE FROM patched_defs')

    const rows: DefInsertRow[] = []
    // same-mod duplicate (defName, defType): the game logs an error and keeps
    // the first (DefDatabase.AddAllInMods) — flat is (loadOrder, filePath)
    // sorted, so "first" = alphabetically first file, deterministic
    const seenDefKeys = new Set<string>()
    flat.forEach((entry, index) => {
      const resolvedDef = mergedDefs[index]
      if (!resolvedDef.defName) return // abstract templates etc.

      const defKey = `${entry.ref.modId}|${entry.defType}|${resolvedDef.defName}`
      if (seenDefKeys.has(defKey)) {
        console.warn(
          `[index-defs] duplicate def "${resolvedDef.defName}" (${entry.defType}) in mod ${entry.ref.modId} at ${entry.ref.filePath}; keeping the first occurrence`,
        )
        return
      }
      seenDefKeys.add(defKey)

      const mayRequire =
        [entry.def['@_MayRequire'], entry.def['@_MayRequireAnyOf']]
          .filter((v): v is string => typeof v === 'string')
          .join('|') || null

      rows.push({
        defName: resolvedDef.defName,
        defType: entry.defType,
        modId: entry.ref.modId,
        loadOrder: entry.ref.loadOrder,
        label: resolvedDef.label ?? null,
        filePath: entry.ref.filePath,
        mayRequire,
        rawPayload: JSON.stringify(rawOf(entry.def)),
        mergedPayload: JSON.stringify(resolvedDef),
      })
    })

    replaceDefs(db, rows)
    replaceDefNames(db, nameRegistry)
    console.log(
      `Build complete! ${rows.length} def rows, ${nameRegistry.length} @Name registrations written.`,
    )
  } finally {
    db.close()
  }
}

// #region Scanners — see utils/asset-scan.ts (shared with index-patches)

// #endregion

// rawPayload keeps the def as authored (minus the injected defType marker)
function rawOf(def: Def): Def {
  const { defType: _t, ...rest } = def
  return rest as Def
}

if (import.meta.main) {
  await rebuildDefsIndex()
}
