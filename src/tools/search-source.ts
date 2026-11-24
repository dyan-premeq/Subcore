import { spawn, Glob } from 'bun'
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { basename, join, posix } from 'node:path'
import { PathSandbox } from '../utils/path-sandbox'
import { textResponse } from '../utils/mcp-response'
import { readManifest } from '../utils/manifest'
import { escapePackageDirName } from '../utils/mod-discovery'
import { findFilesContainingFragment } from '../repositories/source-fts-repo'
import type { ModsManifest } from '../types'

const MAX_OUTPUT_SIZE = 100 * 1024
const MAX_RESULT_LINES = 400
const STDERR_CAPTURE_SIZE = 8 * 1024
const SANDBOX_ROOT_DIRS = new Set(['defs', 'patches', 'source', 'mods', 'data'])

export type SearchScope = 'vanilla' | 'mods' | 'all' | string

function normalizeFilePattern(
  sandboxRoot: string,
  scope: SearchScope,
  filePattern: string | undefined,
): string | undefined {
  if (!filePattern || filePattern.startsWith('!')) return filePattern
  const clean = filePattern.replaceAll('\\', '/').replace(/^\.?\/+/, '')
  if (!clean.includes('/')) return clean
  const firstSeg = clean.slice(0, clean.indexOf('/'))
  if (firstSeg === '*' || firstSeg === '**') return clean
  const lower = firstSeg.toLowerCase()
  if (scope === 'all' || scope === 'vanilla') {
    if (SANDBOX_ROOT_DIRS.has(lower) || existsSync(join(sandboxRoot, firstSeg))) {
      return clean
    }
  } else if (lower === 'mods') {
    return clean
  }
  return `**/${clean}`
}

export interface SearchSourceOptions {
  /** 'vanilla' | 'mods' | 'all' (default) | a packageId */
  scope?: SearchScope
  /** true = restrict to the manifest's active-corpus files (default false) */
  loadedOnly?: boolean
  /** max result lines; clamped to MAX_RESULT_LINES (400) */
  limit?: number
  /** injectable for tests; defaults to dist/mods-manifest.json */
  manifest?: ModsManifest | null
}

export async function searchSourceImpl(
  db: Database,
  sandbox: PathSandbox,
  query: string,
  caseSensitive: boolean = false,
  filePattern?: string,
  options: SearchSourceOptions = {},
) {
  // Tolerate the observed misuse "Mods/<packageId>": strip the prefix once
  // so both scope consumers (path resolution, loaded_only exclusions) see
  // the bare packageId.
  const scope = options.scope?.replace(/^mods\//i, '') ?? 'all'

  const manifest = options.loadedOnly
    ? (options.manifest === undefined ? readManifest() : options.manifest)
    : null
  const resolved = manifest
    ? loadedScope(sandbox.basePath, scope, manifest)
    : resolveScopePaths(sandbox.basePath, scope)
  if (resolved.guidance !== undefined) {
    return { output: '', exceededOutputLimit: false, guidance: resolved.guidance }
  }
  const exclusions = resolved.exclusions ?? []
  const paths = (resolved.paths ?? []).filter(path => existsSync(sandbox.validateAndResolve(path)))
  if (paths.length === 0) return { output: '', exceededOutputLimit: false }

  const effectivePattern = normalizeFilePattern(sandbox.basePath, scope, filePattern)

  // A plain identifier can only hit inside a single token, so the FTS vocab
  // yields a candidate-file superset that scanCandidates filters exactly.
  // Real regex queries keep the full rg scan.
  const candidates = /^[A-Za-z0-9_]+$/.test(query)
    ? findFilesContainingFragment(db, query)
    : null
  if (candidates) {
    return scanCandidates(sandbox, candidates, query, caseSensitive, effectivePattern, paths, exclusions)
  }
  return runRg(sandbox, query, caseSensitive, effectivePattern, paths, exclusions)
}

/** Full rg scan for regex queries. Same result shape as scanCandidates. */
async function runRg(
  sandbox: PathSandbox,
  query: string,
  caseSensitive: boolean,
  filePattern: string | undefined,
  paths: string[],
  exclusions: string[],
) {
  const args = ['--line-number', '--heading', '--color', 'never']

  if (caseSensitive) {
    args.push('-s')
  } else {
    args.push('-i')
  }

  if (filePattern) {
    args.push('-g', filePattern)
  }

  // search pattern + paths
  args.push('-e', query)
  args.push(...paths)

  const exclusionFlag = process.platform === 'win32' ? '--iglob' : '-g'
  for (const glob of exclusions) {
    args.push(exclusionFlag, glob)
  }

  const rgProcess = spawn({
    cmd: ['rg', ...args],
    cwd: sandbox.basePath,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdoutPromise = readStreamWithLimit(
    rgProcess.stdout,
    MAX_OUTPUT_SIZE,
    () => rgProcess.kill(),
  )
  const stderrPromise = readStreamWithLimit(
    rgProcess.stderr,
    STDERR_CAPTURE_SIZE,
  )

  const [exitCode, stdout, stderr] = await Promise.all([
    rgProcess.exited,
    stdoutPromise,
    stderrPromise,
  ])

  const trimmedStdout = stdout.text.trimEnd()
  if (stdout.exceeded) {
    return {
      output: trimmedStdout,
      exceededOutputLimit: true,
    }
  }

  if (exitCode === 0) {
    return { output: trimmedStdout, exceededOutputLimit: false }
  }

  // rg returns exit code 1 when no results found
  if (exitCode === 1) {
    return { output: '', exceededOutputLimit: false }
  }

  const stderrText = stderr.text.trim()
  if (stderrText.length > 0) {
    throw new Error(`rg failed with exit code ${exitCode}: ${stderrText}`)
  }
  throw new Error(`rg failed with exit code ${exitCode}`)
}

/**
 * Line-scans the FTS candidate files, reproducing rg's `--line-number
 * --heading` output shape (heading line, then `N:text`, blank line between
 * files). Stops reading further files once the output passes
 * MAX_OUTPUT_SIZE — the same budget that kills a running rg.
 */
async function scanCandidates(
  sandbox: PathSandbox,
  candidates: string[],
  query: string,
  caseSensitive: boolean,
  filePattern: string | undefined,
  paths: string[],
  exclusions: string[],
) {
  const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  const scopeRoots = paths.includes('.') ? null : paths.map(pathKey)
  // a pattern without '/' matches against the basename only (rg -g semantics);
  // an anchored one matches the whole sandbox-relative path
  const basenameGlob =
    filePattern !== undefined && !filePattern.includes('/')
      ? new Glob(filePattern)
      : undefined
  const pathGlob =
    filePattern !== undefined && filePattern.includes('/')
      ? new Glob(filePattern)
      : undefined
  const exclusionGlobs = exclusions.map(glob => new Glob(pathKey(glob.slice(1))))
  const regex = new RegExp(query, caseSensitive ? '' : 'i')

  let output = ''
  let bytes = 0
  let truncated = false

  for (const path of candidates) {
    const candidate = pathKey(path)
    if (scopeRoots && !scopeRoots.some(root => candidate === root || candidate.startsWith(`${root}/`))) continue
    if (basenameGlob && !basenameGlob.match(basename(path))) continue
    if (pathGlob && !pathGlob.match(path)) continue
    if (exclusionGlobs.some(glob => glob.match(candidate))) continue

    const text = await Bun.file(join(sandbox.basePath, path)).text()
    const hits: string[] = []
    let lineNo = 0
    for (const line of text.split(/\r?\n/)) {
      lineNo += 1
      if (regex.test(line)) hits.push(`${lineNo}:${line}`)
    }
    if (hits.length === 0) continue

    const block = `${path}\n${hits.join('\n')}`
    const chunk = output.length === 0 ? block : `\n\n${block}`
    const chunkBytes = Buffer.byteLength(chunk)
    if (bytes + chunkBytes > MAX_OUTPUT_SIZE) {
      // cut at the byte budget, exactly what readStreamWithLimit does to rg
      output += Buffer.from(chunk).subarray(0, MAX_OUTPUT_SIZE - bytes).toString()
      truncated = true
      break
    }
    output += chunk
    bytes += chunkBytes
  }

  return { output, exceededOutputLimit: truncated }
}

interface ScopeResolution {
  paths?: string[]
  exclusions?: string[]
  guidance?: string
}

/**
 * Resolves rg path arguments for a scope. Paths are relative to the sandbox
 * root (dist/assets). Unknown packageIds or a missing Mods tree produce
 * guidance instead of a silent empty result.
 */
function resolveScopePaths(sandboxRoot: string, scope: SearchScope): ScopeResolution {
  if (scope === 'all') return { paths: ['.'] }
  if (scope === 'vanilla') return { paths: ['Defs', 'Patches', 'Source'] }

  const modsRoot = join(sandboxRoot, 'Mods')
  if (scope === 'mods') {
    return existsSync(modsRoot)
      ? { paths: ['Mods'] }
      : { guidance: 'No mods imported yet. Run import-mods + build, or use scope "vanilla".' }
  }

  const dir = `Mods/${escapePackageDirName(scope)}`
  if (!existsSync(join(modsRoot, escapePackageDirName(scope)))) {
    return {
      guidance:
        `Unknown scope "${scope}". ` +
        `Valid: 'all' (default), 'vanilla' (Defs + Patches + Source), 'mods', or a packageId ` +
        `(e.g. 'ancot.kiirorace') — list them with list_mods.`,
    }
  }
  return { paths: [dir] }
}

function loadedScope(sandboxRoot: string, scope: SearchScope, manifest: ModsManifest): ScopeResolution {
  if (scope !== 'all' && scope !== 'vanilla' && scope !== 'mods') {
    const id = scope.toLowerCase()
    const inProfileMod = manifest.mods.find(mod => mod.inProfile && mod.assetPath && mod.packageId === id)
    if (!inProfileMod) {
      const knownInactive =
        manifest.mods.some(mod => !mod.inProfile && mod.packageId === id) ||
        manifest.discoveredNotInProfile.some(mod => mod.packageId === id) ||
        existsSync(join(sandboxRoot, 'Mods', escapePackageDirName(scope)))
      if (knownInactive) {
        return {
          guidance: `Mod "${scope}" is not in the active profile; use loaded_only=false to search non-loaded files.`,
        }
      }
    }
  }
  const base = resolveScopePaths(sandboxRoot, scope)
  if (base.guidance !== undefined) return base

  const roots = new Set<string>()
  const exclusions: string[] = []
  if (scope === 'all' || scope === 'vanilla') {
    for (const dir of ['Defs', 'Patches', 'Source']) roots.add(dir)
  }
  for (const mod of manifest.mods) {
    if (!mod.inProfile || !mod.assetPath) continue
    if (scope !== 'all' && scope !== 'mods' && mod.packageId !== scope.toLowerCase()) continue
    for (const dir of ['About', 'Source', 'Source-decompiled']) {
      roots.add(posix.join(mod.assetPath, dir))
    }
    for (const folder of mod.activeFolders) {
      for (const dir of ['Defs', 'Patches', 'Languages', 'Source', 'Assemblies']) {
        roots.add(posix.join(mod.assetPath, folder, dir))
      }
    }
    for (const file of mod.shadowedFiles) exclusions.push('!' + mod.assetPath + '/' + file)
  }
  return { paths: [...roots], exclusions }
}

export async function searchSource(
  db: Database,
  sandbox: PathSandbox,
  query: string,
  caseSensitive: boolean = false,
  filePattern?: string,
  options: SearchSourceOptions = {},
) {
  const { output, exceededOutputLimit, guidance } = await searchSourceImpl(
    db,
    sandbox,
    query,
    caseSensitive,
    filePattern,
    options,
  )

  if (guidance) {
    return textResponse(guidance, true)
  }

  // rg prefixes heading lines with './' when the scope searches '.', and
  // Windows rg may emit backslash separators. Normalize heading lines (the
  // non-empty ones without a line-number prefix) so the rg and the FTS path
  // emit the same posix, sandbox-relative shape.
  const normalized = output
    .split(/\r?\n/)
    .map(line =>
      line.length > 0 && !/^\d+:/.test(line)
        ? line.replaceAll('\\', '/').replace(/^\.\//, '')
        : line,
    )
    .join('\n')

  if (normalized.length === 0 && !exceededOutputLimit) {
    let message = `No matches for /${query}/ in scope '${options.scope ?? 'all'}'`
    if (filePattern) {
      message += `, file_pattern '${filePattern}'`
    }
    if (filePattern?.includes('/') && !filePattern.includes('**')) {
      message +=
        "\nNote: globs use gitignore semantics — a single '*' does not cross '/';" +
        " to limit to one mod use scope:'<packageId>' instead."
    }
    return textResponse(message)
  }

  if (exceededOutputLimit) {
    let truncated = normalized
    truncated += '\n\n[TRUNCATED] Output size exceeded 100KB.'
    truncated +=
      '\n(Tip: Refine your search query or add a more specific `file_pattern`.)'
    return textResponse(truncated)
  }

  const maxLines = Math.min(options.limit ?? MAX_RESULT_LINES, MAX_RESULT_LINES)
  const lines = normalized.split(/\r?\n/)
  if (lines.length > maxLines) {
    const truncated = lines.slice(0, maxLines)
    truncated.push(
      `\n[TRUNCATED] Showing ${maxLines}/${lines.length} results.`,
    )
    truncated.push(
      '(Tip: Refine your search query or add a more specific `file_pattern`.)',
    )
    return textResponse(truncated.join('\n'))
  }

  if (options.loadedOnly && !(options.manifest !== undefined ? options.manifest : readManifest())) {
    return textResponse(
      normalized +
        '\n\n[Note] No mods manifest found (import-mods never ran); loaded_only was ignored.',
    )
  }

  return textResponse(normalized)
}

// #region Helper
async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimitReached?: () => void,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const nextBytes = totalBytes + value.byteLength
    if (nextBytes > maxBytes) {
      const remaining = maxBytes - totalBytes
      if (remaining > 0) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true })
      }
      text += decoder.decode()
      onLimitReached?.()
      await reader.cancel()
      return { text, exceeded: true }
    }

    totalBytes = nextBytes
    text += decoder.decode(value, { stream: true })
  }

  text += decoder.decode()
  return { text, exceeded: false }
}
// #endregion
