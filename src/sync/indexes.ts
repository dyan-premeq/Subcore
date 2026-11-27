import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { getModByPackageId, listProfileMods } from '../repositories/mods-repo'
import { insertFromManifest } from '../scripts/index-mods'
import type { ModsManifest } from '../types'
import { conditionResults, XmlConditions, type XmlPredicates } from '../utils/xml-conditions'
import { hashValues } from './fingerprints'

function xmlOwners(manifest: ModsManifest) {
  return manifest.mods.filter(m => m.dataCategory || m.effectiveFiles.length)
    .map(m => [m.packageId, m.dataCategory, m.fingerprint])
}

interface IndexUpdate {
  full: boolean
  changed: string[]
  foldersChanged: boolean
  vanillaXml: boolean
  vanillaSource: boolean
  predicates?: XmlPredicates
}

export async function refreshIndexes(
  db: Database, manifest: ModsManifest, prior: ModsManifest | null, update: IndexUpdate,
  assets: string, asset: (prefix: string) => string,
) {
  const { full, vanillaSource, vanillaXml, foldersChanged, changed } = update
  const before = listProfileMods(db)
  const mods = manifest.mods
  const active = new Set(mods.map(m => m.packageId))
  insertFromManifest(db, manifest)
  const removed = before.filter(row => row.assetPath && !active.has(row.packageId))
  const changedPackages = new Set(changed)
  const localDirs = mods.filter(m => changedPackages.has(m.packageId)).map(m => m.assetPath)
  const directory = (prefix: string) => ({ prefix, dir: asset(prefix) })
  const codeDirs = (vanillaSource ? ['Source', ...localDirs] : localDirs).map(directory)
  const ids: (number | null)[] = [...removed.map(m => m.modId), ...changed.map(id => getModByPackageId(db, id)!.modId)]
  if (vanillaSource) ids.push(null)
  if (codeDirs.length || removed.length) {
    const { indexCsharp } = await import('../scripts/index-csharp')
    await indexCsharp(db, assets, codeDirs, ids, full)
  }
  const sourceDirs = vanillaXml ? [...codeDirs, directory('Defs'), directory('Patches')] : codeDirs
  if (sourceDirs.length || removed.length) {
    const { indexSourceFiles } = await import('../scripts/index-source')
    await indexSourceFiles(db, assets, sourceDirs, removed.map(m => m.assetPath), full)
  }

  let predicates = update.predicates
  const xmlRebuilt = !prior || !predicates || vanillaXml || foldersChanged ||
    hashValues(xmlOwners(prior)) !== hashValues(xmlOwners(manifest)) ||
    hashValues(conditionResults(predicates, prior.mods)) !== hashValues(conditionResults(predicates, mods))
  if (xmlRebuilt) {
    const { indexDefs } = await import('../scripts/index-defs')
    const { indexPatches } = await import('../scripts/index-patches')
    const trace = new XmlConditions()
    await indexDefs(db, asset('Defs'), join(assets, 'Mods'), manifest, trace, asset)
    await indexPatches(db, asset('Defs'), asset('Patches'), join(assets, 'Mods'), manifest, {}, trace, asset)
    predicates = trace.snapshot()
  } else if (before.some(row => manifest.mods[row.loadOrder]?.packageId !== row.packageId)) {
    // XML owners retain relative order, but a code-only insertion can shift their published order numbers.
    for (const table of ['defs', 'def_names']) {
      db.run('UPDATE ' + table + ' AS d SET loadOrder=m.loadOrder FROM mods m WHERE d.modId=m.modId AND d.loadOrder<>m.loadOrder')
    }
  }
  return { removedMods: removed.map(m => m.packageId), xmlRebuilt, predicates }
}
