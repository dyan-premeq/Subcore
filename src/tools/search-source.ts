import { spawn, Glob } from 'bun'
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PathSandbox } from '../utils/path-sandbox'
import { textResponse } from '../utils/mcp-response'
import { readManifest } from '../utils/manifest'
import { escapePackageDirName } from '../utils/mod-discovery'
import { findFilesContainingFragment } from '../repositories/source-fts-repo'
import type { ManifestMod, ModsManifest } from '../types'

const MAX_OUTPUT_SIZE = 100 * 1024
const MAX_RESULT_LINES = 400
const STDERR_CAPTURE_SIZE = 8 * 1024

export type SearchScope = 'vanilla' | 'mods' | 'all' | string

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

  const resolved = resolveScopePaths(sandbox.basePath, scope)
  if (resolved.guidance !== undefined) {
    return { output: '', exceededOutputLimit: false, guidance: resolved.guidance }
  }
  // skip scopes that point at directories missing from this dist (a vanilla
  // sandbox has no Mods/, a mods-less one may lack Source/) instead of
  // making rg fail
  const paths = (resolved.paths ?? []).filter(path => {
    if (path === '.') return true
    return existsSync(join(sandbox.basePath, path))
  })
  if (paths.length === 0) {
    // requested scope has no files in this dist at all
    return { output: '', exceededOutputLimit: false }
  }

  const exclusions = options.loadedOnly
    ? resolveLoadedOnlyExclusions(
        scope,
        options.manifest !== undefined ? options.manifest : readManifest(),
      )
    : []

  // A plain identifier can only hit inside a single token, so the FTS vocab
  // yields a candidate-file superset that scanCandidates filters exactly.
  // Real regex queries keep the full rg scan.
  const candidates = /^[A-Za-z0-9_]+$/.test(query)
    ? findFilesContainingFragment(db, query)
    : null
  if (candidates) {
    return scanCandidates(sandbox, candidates, query, caseSensitive, filePattern, paths, exclusions)
  }
  return runRg(sandbox, query, caseSensitive, filePattern, paths, exclusions)
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

  for (const glob of exclusions) {
    args.push('-g', glob)
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
  const scopeRoots = paths.includes('.') ? null : paths
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
  const exclusionGlobs = exclusions.map(glob => new Glob(glob.slice(1)))
  const regex = new RegExp(query, caseSensitive ? '' : 'i')

  let output = ''
  let bytes = 0
  let truncated = false

  for (const path of candidates) {
    if (scopeRoots && !scopeRoots.some(root => path.startsWith(`${root}/`))) continue
    if (basenameGlob && !basenameGlob.match(basename(path))) continue
    if (pathGlob && !pathGlob.match(path)) continue
    if (exclusionGlobs.some(glob => glob.match(path))) continue

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
  guidance?: string
}

/**
 * Resolves rg path arguments for a scope. Paths are relative to the sandbox
 * root (dist/assets). Unknown packageIds or a missing Mods tree produce
 * guidance instead of a silent empty result.
 */
function resolveScopePaths(sandboxRoot: string, scope: SearchScope): ScopeResolution {
  if (scope === 'all') return { paths: ['.'] }
  if (scope === 'vanilla') return { paths: ['Defs', 'Source'] }

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
        `Valid: 'all' (default), 'vanilla' (Defs + Source), 'mods', or a packageId ` +
        `(e.g. 'ancot.kiirorace') — list them with list_mods.`,
    }
  }
  return { paths: [dir] }
}

/**
 * Exclusion globs for loaded_only=true: non-selected version folders and
 * shadowed files stay searchable in loaded_only=false mode only.
 */
function resolveLoadedOnlyExclusions(
  scope: SearchScope,
  manifest: ModsManifest | null,
): string[] {
  if (!manifest) return []

  const mods: ManifestMod[] = manifest.mods.filter(
    mod =>
      mod.assetPath !== '' &&
      (scope === 'all' || scope === 'mods' || mod.packageId === scope.toLowerCase()),
  )

  const globs: string[] = []
  for (const mod of mods) {
    const selected = new Set(mod.activeFolders)
    for (const folder of [...mod.versionDirs, 'Common']) {
      if (!selected.has(folder)) {
        globs.push(`!${mod.assetPath}/${folder}/**`)
      }
    }
    for (const file of mod.shadowedFiles) {
      globs.push(`!${mod.assetPath}/${file}`)
    }
  }
  return globs
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
    return textResponse(guidance)
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
