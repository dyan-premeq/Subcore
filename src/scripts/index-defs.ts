import { existsSync, readdirSync } from 'node:fs'
import { file, Glob } from 'bun'
import { Database } from 'bun:sqlite'
import { join, sep } from 'node:path'
import type { Def, ModsManifest } from '../types'
import { defsPath, indexDbPath, modsAssetPath, modsManifestPath } from '../utils/env'
import { parser } from '../utils/xml-utils'
import { processDefs } from '../utils/def-resolver'
import { ensureSchema } from '../db/schema'
import { replaceDefs, type DefInsertRow } from '../repositories/defs-repo'
import {
  countMods,
  getModByDataCategory,
  getModByPackageId,
} from '../repositories/mods-repo'
import { readManifest } from '../utils/manifest'
import { escapePackageDirName } from '../utils/mod-discovery'
import { compareStrings } from '../utils/compare'

interface DefFileRef {
  /** absolute path to read */
  absPath: string
  /** dist/assets-relative path (aligns with rg output) */
  filePath: string
  modId: number
  loadOrder: number
}

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
    const manifest = readManifest(manifestPath)
    const refs: DefFileRef[] = []
    refs.push(...(await scanVanillaDefs(db, defsSourcePath)))
    refs.push(...scanModDefs(db, modsSourcePath, manifest))
    console.log(`Collected ${refs.length} def files.`)

    // 3. parse & flatten
    console.log('Parsing files...')
    const flat: FlatDef[] = []
    await Promise.all(
      refs.map(async ref => {
        const xml = await file(ref.absPath).text()
        const defsRoot = parser.parse(xml).Defs as Record<string, unknown> | undefined
        if (!defsRoot) return

        for (const [defType, defsForType] of Object.entries(defsRoot)) {
          if (!Array.isArray(defsForType)) continue
          for (const def of defsForType as Def[]) {
            if (!def || typeof def !== 'object') continue
            flat.push({ def: Object.assign({ defType }, def), defType, ref })
          }
        }
      }),
    )

    // 4. resolve inheritance. Order by loadOrder so the existing resolver's
    // "last named def wins" matches the game's parent preference; exact
    // XmlInheritance semantics land in M2.
    console.log(`Resolving inheritance for ${flat.length} defs...`)
    flat.sort(
      (a, b) =>
        a.ref.loadOrder - b.ref.loadOrder ||
        compareStrings(a.ref.filePath, b.ref.filePath),
    )
    const mergedDefs = processDefs(flat.map(entry => entry.def))

    // 5. write (all versions kept; effective = highest loadOrder)
    console.log('Writing defs to db...')
    db.run('DELETE FROM defs')

    const rows: DefInsertRow[] = []
    // same-mod duplicate (defName, defType): the game logs an error and keeps
    // the first (DefDatabase.AddAllInMods, §4.2) — flat is (loadOrder, filePath)
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
    console.log(`Build complete! ${rows.length} def rows written.`)
  } finally {
    db.close()
  }
}

// #region Scanners

async function scanVanillaDefs(db: Database, defsSourcePath: string): Promise<DefFileRef[]> {
  if (!existsSync(defsSourcePath)) return []

  const glob = new Glob('**/*.xml')
  const out: DefFileRef[] = []

  for await (const relativePath of glob.scan({ cwd: defsSourcePath })) {
    const parts = relativePath.split(sep)
    if (parts.length < 2) {
      // import-defs always writes Data/<category>/... — a root-level file here
      // means a corrupted dist layout, not "Core"
      console.warn(`Skipping ${relativePath}: no category folder (run import-defs).`)
      continue
    }
    const category = parts[0]
    const mod = getModByDataCategory(db, category)
    if (!mod) {
      console.warn(`No mod row for vanilla category "${category}"; skipping ${relativePath}`)
      continue
    }
    out.push({
      absPath: join(defsSourcePath, relativePath),
      filePath: toPosix(relativePath),
      modId: mod.modId,
      loadOrder: mod.loadOrder,
    })
  }

  console.log(`Vanilla def files: ${out.length}`)
  return out
}

function scanModDefs(
  db: Database,
  modsSourcePath: string,
  manifest: ModsManifest | null,
): DefFileRef[] {
  if (!existsSync(modsSourcePath)) return []

  const out: DefFileRef[] = []

  const modDirs = readdirSync(modsSourcePath, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)

  for (const dirName of modDirs) {
    const manifestMod = manifest?.mods.find(
      m => m.assetPath === `Mods/${dirName}` || escapePackageDirName(m.packageId) === dirName,
    )
    const modRow = manifestMod ? getModByPackageId(db, manifestMod.packageId) : null

    if (!modRow) {
      console.warn(`No mod row for dist mod dir "${dirName}" (run index-mods first); skipping.`)
      continue
    }

    // effective file set from the manifest; degrade to "all XML" with a
    // loud warning when import-mods never ran
    let files: string[]
    if (manifestMod) {
      files = manifestMod.effectiveFiles
    } else {
      console.warn(
        `[warn] no manifest entry for ${dirName}; indexing ALL XML under it ` +
          '(run import-mods for effective-set filtering)',
      )
      files = listXmlUnder(join(modsSourcePath, dirName))
    }

    for (const rel of files) {
      const posix = toPosix(rel)
      // only Defs/ folders produce defs (Patches are M3's patch_ops)
      if (!/(^|\/)Defs\//.test(posix)) continue
      out.push({
        absPath: join(modsSourcePath, dirName, rel),
        filePath: `Mods/${dirName}/${posix}`,
        modId: modRow.modId,
        loadOrder: modRow.loadOrder,
      })
    }
  }

  console.log(`Mod def files: ${out.length}`)
  return out
}

function listXmlUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.toLowerCase().endsWith('.xml')) out.push(full.slice(root.length + 1))
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

// #endregion

// rawPayload keeps the def as authored (minus the injected defType marker)
function rawOf(def: Def): Def {
  const { defType: _t, ...rest } = def
  return rest as Def
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

if (import.meta.main) {
  await rebuildDefsIndex()
}
