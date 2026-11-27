import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { modContentTree } from '../scripts/import-mods'
import { VANILLA_ASSEMBLIES } from '../scripts/import-vanilla'
import type { ModInfo } from '../types'
import { listXmlFiles } from '../utils/load-folders'
import { compareStrings } from '../utils/compare'

export function digest(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function hashValues(data: unknown): string {
  return digest(JSON.stringify(data))
}

export function fingerprintMod(mod: ModInfo, observe: (path: string) => void) {
  const files: [string, string | null][] = []
  for (const dir of modContentTree(mod)) {
    observe(dir.srcDir)
    for (const entry of dir.entries) {
      const path = join(dir.srcDir, entry.name)
      const name = join(dir.destDir, entry.destName).replaceAll('\\', '/')
      const hash = entry.directory ? null : digest(readFileSync(path))
      files.push([name, hash])
      if (hash !== null) observe(path)
    }
  }
  return hashValues(files.sort(([a], [b]) => compareStrings(a, b)))
}

export function fingerprintVanilla(gameRoot: string, mods: ModInfo[], observe: (path: string) => void) {
  observe(gameRoot)
  const data = join(gameRoot, 'Data')
  if (existsSync(data)) observe(data)
  const xml: [string, string][] = []
  for (const mod of mods) {
    if (!mod.dataCategory) continue
    observe(mod.rootPath)
    for (const kind of ['Defs', 'Patches']) {
      const dir = join(mod.rootPath, kind)
      if (!existsSync(dir)) continue
      for (const path of listXmlFiles(dir, observe)) {
        observe(path)
        xml.push([relative(gameRoot, path), digest(readFileSync(path))])
      }
    }
  }
  const assemblies = VANILLA_ASSEMBLIES.flatMap(name => {
    const path = join(gameRoot, name + '.dll')
    if (!existsSync(path)) return []
    observe(path)
    return [[name, digest(readFileSync(path))]]
  })
  return { xml: hashValues(xml), source: hashValues(assemblies) }
}
