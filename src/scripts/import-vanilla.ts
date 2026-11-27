import { Glob, spawnSync } from 'bun'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { distPath, gameRootFromEnv } from '../utils/env'
import { importedGameRoot, markStandaloneImport } from '../utils/manifest'
import { findIlspycmd, stripIlComments } from '../utils/decompile'
import { listXmlFiles } from '../utils/load-folders'

export const VANILLA_ASSEMBLIES = ['Assembly-CSharp', 'UnityStubs', 'RimWorldWaylith.PrepatcherCompat']

interface ImportVanillaOptions {
  gameRoot: string
  distRoot?: string
  full?: boolean
  ilspyCmd?: string | null
}

export function importVanilla({
  gameRoot, distRoot = distPath, full = false, ilspyCmd = findIlspycmd(),
}: ImportVanillaOptions): void {
  const versionFile = join(gameRoot, 'Version.txt')
  if (!existsSync(versionFile)) throw new Error('Missing Version.txt in ' + gameRoot)

  markStandaloneImport(distRoot, gameRoot)
  const assets = join(distRoot, 'assets')
  importVanillaXml(gameRoot, assets)
  copyFileSync(versionFile, join(distRoot, 'Version.txt'))
  importVanillaSource(gameRoot, assets, full, ilspyCmd)
}

export function importVanillaXml(gameRoot: string, assets: string): void {
  const data = join(gameRoot, 'Data')
  const categories = existsSync(data) ? readdirSync(data, { withFileTypes: true }) : []
  for (const kind of ['Defs', 'Patches']) {
    const out = join(assets, kind)
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    for (const category of categories) {
      const input = join(data, category.name, kind)
      if (!category.isDirectory() || !existsSync(input)) continue
      for (const xml of listXmlFiles(input)) {
        const dest = join(out, category.name, relative(input, xml))
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(xml, dest)
      }
    }
  }
}

export function importVanillaSource(gameRoot: string, assets: string, full: boolean, ilspyCmd: string | null): void {
  const source = join(assets, 'Source')
  mkdirSync(source, { recursive: true })
  const targets = VANILLA_ASSEMBLIES.filter(name => existsSync(join(gameRoot, name + '.dll')))
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !targets.includes(entry.name)) {
      rmSync(join(source, entry.name), { recursive: true, force: true })
    }
  }
  for (const name of targets) {
    const dll = join(gameRoot, name + '.dll')
    const out = join(source, name)
    if (!full && existsSync(out) && statSync(out).mtimeMs >= statSync(dll).mtimeMs) continue
    if (!ilspyCmd) throw new Error('Vanilla source import requires ilspycmd (dotnet tool install -g ilspycmd)')
    const tmp = out + '.tmp'
    rmSync(out, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
    try {
      console.error('Decompiling ' + name)
      const result = spawnSync([ilspyCmd, '-p', '-r', gameRoot, '-o', tmp, dll, '--disable-updatecheck'])
      if (result.exitCode !== 0) throw new Error(name + ': ' + result.stderr.toString())
      for (const path of new Glob('**/*.csproj').scanSync({ cwd: tmp, absolute: true, dot: true })) rmSync(path)
      for (const path of new Glob('**/*.cs').scanSync({ cwd: tmp, absolute: true, dot: true })) stripIlComments(path)
      renameSync(tmp, out)
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true })
      throw error
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun run import:vanilla [gameRoot] [--full]\ngameRoot defaults to SUBCORE_GAME_ROOT or the last imported installation.')
  } else {
    const gameRoot = args.find(arg => !arg.startsWith('-')) ?? gameRootFromEnv() ?? importedGameRoot()
    if (!gameRoot) throw new Error('Pass the game root or set SUBCORE_GAME_ROOT.')
    importVanilla({ gameRoot, full: args.includes('--full') })
  }
}
