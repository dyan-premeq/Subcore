import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

// The SQLite writer holds BEGIN IMMEDIATE from recovery through publication.
// Changed trees are indexed off to the side. Only the final renames touch live assets.
export class SyncStage {
  private readonly dist: string
  private readonly root: string
  private readonly paths = new Set<string>()

  constructor(dist: string) {
    this.dist = dist
    this.root = join(dist, '.sync-stage')
  }

  next(path: string): string {
    this.paths.add(path)
    return join(this.root, 'next', path)
  }

  asset = (prefix: string): string => {
    const path = 'assets/' + prefix
    return this.paths.has(path) ? join(this.root, 'next', path) : join(this.dist, path)
  }

  publish(generation: string): void {
    const paths: { path: string; previous: string; existed: boolean }[] = []
    const collect = (path: string, previous = path) => {
      const live = join(this.dist, previous)
      const next = join(this.root, 'next', path)
      const old = lstatSync(live, { throwIfNoEntry: false })
      const fresh = lstatSync(next, { throwIfNoEntry: false })
      if (old?.isDirectory() && fresh?.isDirectory() && path === previous) {
        // Other Windows processes can hold a directory or a file anywhere below it.
        // Publish just the changed children and preserve handles to identical files.
        const key = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name
        const before = new Map(readdirSync(live).map(name => [key(name), name]))
        for (const name of readdirSync(next)) {
          const oldName = before.get(key(name)) ?? name
          before.delete(key(name))
          collect(path + '/' + name, path + '/' + oldName)
        }
        for (const name of before.values()) collect(path + '/' + name)
      } else if (path !== previous || !old?.isFile() || !fresh?.isFile() ||
                 old.size !== fresh.size || !readFileSync(live).equals(readFileSync(next))) {
        if (old || fresh) paths.push({ path, previous, existed: Boolean(old) })
      }
    }
    for (const path of this.paths) collect(path)
    const journal = join(this.root, 'publish.json')
    writeFileSync(journal + '.tmp', JSON.stringify({ generation, paths }))
    renameSync(journal + '.tmp', journal)
    for (const { path, previous, existed } of paths) {
      const live = join(this.dist, path)
      const next = join(this.root, 'next', path)
      if (existed) {
        const backup = join(this.root, 'previous', path)
        mkdirSync(dirname(backup), { recursive: true })
        renameSync(join(this.dist, previous), backup)
      }
      if (existsSync(next)) {
        mkdirSync(dirname(live), { recursive: true })
        renameSync(next, live)
      }
    }
  }

  /** Also repairs an interrupted publish after an ungraceful process exit. */
  recover(committed: string | null): void {
    if (!existsSync(this.root)) return
    const journal = join(this.root, 'publish.json')
    if (existsSync(journal)) {
      const { generation, paths } = JSON.parse(readFileSync(journal, 'utf8')) as {
        generation: string; paths: { path: string; previous: string; existed: boolean }[]
      }
      if (generation !== committed) {
        for (const { path, previous, existed } of paths.reverse()) {
          const live = resolve(this.dist, path)
          if (![live, resolve(this.dist, previous)].every(p => p.startsWith(resolve(this.dist) + sep))) throw new Error('Invalid sync journal path: ' + path)
          const backup = join(this.root, 'previous', path)
          if (!existed || existsSync(backup)) rmSync(live, { recursive: true, force: true })
          if (existsSync(backup)) renameSync(backup, join(this.dist, previous))
        }
      }
    }
    rmSync(this.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
