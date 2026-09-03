import type { Database } from 'bun:sqlite'
import { file } from 'bun'
import { join } from 'node:path'
import { textResponse } from '../utils/mcp-response'
import { findCsharpTypes, type CsharpSearchRow } from '../repositories/csharp-repo'

interface CodeBlock {
  startLine: number
  lineCount: number
  code: string
}

interface CSharpSymbolResult {
  filePath: string
  startLine: number
  lineCount: number
  code: string
  isTruncated: boolean
}

const MAX_LINES_THRESHOLD = 400

export async function readCsharpSymbolImpl(
  sourcePath: string,
  rows: CsharpSearchRow[],
  memberName?: string,
): Promise<CSharpSymbolResult[]> {
  const results: CSharpSymbolResult[] = []

  for (const row of rows) {
    const fullPath = join(sourcePath, row.filePath)
    const content = await file(fullPath).text()
    const allLines = content.split(/\r?\n/)
    const typeBlock = extractScopedBlock(allLines, row.startLine)
    const blocks = memberName
      ? extractNamedMethods(
          allLines,
          row.startLine,
          typeBlock.lineCount,
          memberName,
        )
      : [typeBlock]

    for (const block of blocks) {
      results.push({
        filePath: row.filePath,
        startLine: block.startLine,
        lineCount: block.lineCount,
        code: memberName ? dedentCode(block.code) : block.code,
        isTruncated: block.lineCount > MAX_LINES_THRESHOLD,
      })
    }
  }

  return results
}

export async function readCsharpSymbol(
  db: Database,
  sourcePath: string,
  symbol: string,
  memberName?: string,
  filePath?: string,
) {
  // csharp_index stores bare type names. Accept Namespace.Type (tail is a type)
  // and Type.Member (tail is not a type, the segment before it is).
  const segments = symbol.split('.')
  let typeName = segments.at(-1)!
  let allRows = findCsharpTypes(db, typeName)
  if (allRows.length === 0 && segments.length >= 2 && memberName === undefined) {
    const rows = findCsharpTypes(db, segments.at(-2)!)
    if (rows.length > 0) {
      typeName = segments.at(-2)!
      memberName = segments.at(-1)!
      allRows = rows
    }
  }

  if (allRows.length === 0) {
    const symbolLabel = memberName
      ? `Member '${memberName}' in type '${typeName}'`
      : `Type '${typeName}'`

    return {
      ...textResponse(
        `${symbolLabel} not found in index. Please check the name.`,
      ),
    }
  }

  const normalizedPath =
    filePath === undefined ? undefined : normalizeFilePath(filePath)
  const rows =
    normalizedPath === undefined
      ? allRows
      : allRows.filter(row => row.filePath === normalizedPath)

  // file_path given but matched none of the type's definitions: show the
  // candidates instead of pretending the type does not exist
  if (rows.length === 0) {
    return textResponse(
      `Type '${typeName}' exists but file_path '${normalizedPath}' matched none of its ${allRows.length} definitions:\n` +
        formatDefinitionList(allRows),
    )
  }

  // multiple definitions (vanilla + mods, or several mods): list the
  // sources so the caller can re-invoke with file_path
  if (rows.length > 1) {
    return textResponse(
      `Type '${typeName}' is defined in ${rows.length} files. ` +
        `Call read_csharp_symbol again with file_path to pick one:\n` +
        formatDefinitionList(rows),
    )
  }

  const results = await readCsharpSymbolImpl(sourcePath, rows, memberName)

  if (results.length === 0) {
    // the type exists but the requested member does not
    return {
      ...textResponse(
        `Member '${memberName}' in type '${typeName}' not found in index. Please check the name.`,
      ),
    }
  }

  const parts: string[] = []
  let isTruncatedMode = false

  for (const result of results) {
    let finalCode = result.code
    let header = `// File: ${result.filePath} (Lines ${result.startLine + 1}-${
      result.startLine + result.lineCount
    })`

    if (result.isTruncated) {
      isTruncatedMode = true
      finalCode = generateSignature(result.code)
      header += ` [AUTO-SUMMARY: Hidden method bodies due to size]`
    }

    parts.push(`${header}\n${finalCode}`)
  }

  let output = parts.join('\n\n')

  if (isTruncatedMode) {
    output += `\n\n[SYSTEM NOTE] Some code was automatically summarized because it exceeded the output limit.`
    output += `\nTo read the implementation of a specific method, use the 'read_file' tool with the specific line numbers shown above.`
  }

  return textResponse(output)
}

// #region Helpers
function normalizeFilePath(filePath: string): string {
  return filePath
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^dist\/assets\//, '')
}

function formatDefinitionList(rows: CsharpSearchRow[]): string {
  return rows
    .map(
      row =>
        `[${row.packageId ?? 'vanilla'}] ${row.filePath} (line ${row.startLine + 1})`,
    )
    .join('\n')
}

function extractNamedMethods(
  lines: string[],
  typeStartLine: number,
  typeLineCount: number,
  memberName: string,
): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const memberPattern = new RegExp(`\\b${escapeRegExp(memberName)}\\b`)
  const typeEndLine = typeStartLine + typeLineCount
  let depth = 0

  // Decompiled sources contain no comments; depth and name matching are sufficient.
  for (let i = typeStartLine; i < typeEndLine; i++) {
    const line = lines[i]

    if (i > typeStartLine && depth === 1 && memberPattern.test(line)) {
      blocks.push(extractScopedBlock(lines, i))
    }

    depth += countBraceDelta(line)
  }

  return blocks
}

function extractScopedBlock(lines: string[], startLine: number): CodeBlock {
  const buffer: string[] = []
  let braceCount = 0
  let foundBrace = false

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    buffer.push(line)
    braceCount += countBraceDelta(line)

    if (line.includes('{')) foundBrace = true

    if (foundBrace && braceCount === 0) {
      break
    }

    if (!foundBrace && trimmed.endsWith(';')) {
      break
    }
  }

  return {
    startLine,
    code: buffer.join('\n'),
    lineCount: buffer.length,
  }
}

function dedentCode(code: string): string {
  const lines = code.split('\n')
  let commonIndent: string | null = null

  for (const line of lines) {
    if (!line.trim()) continue

    const indent = line.match(/^\s*/)![0]

    if (commonIndent === null) {
      commonIndent = indent
      continue
    }

    while (commonIndent && !indent.startsWith(commonIndent)) {
      commonIndent = commonIndent.slice(0, -1)
    }
  }

  if (!commonIndent) {
    return code
  }

  return lines
    .map(line =>
      line.startsWith(commonIndent) ? line.slice(commonIndent.length) : line,
    )
    .join('\n')
}

function countBraceDelta(line: string): number {
  let delta = 0

  for (const char of line) {
    if (char === '{') delta += 1
    if (char === '}') delta -= 1
  }

  return delta
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function generateSignature(code: string): string {
  const lines = code.split('\n')
  const output: string[] = []

  let depth = 0

  for (const line of lines) {
    const currentLineDepthChange = countBraceDelta(line)

    if (depth <= 1) {
      if (depth === 1 && currentLineDepthChange > 0) {
        output.push(line)
        if (!line.includes('}')) {
          output.push('    // ... implementation hidden ...')
        }
      } else {
        output.push(line)
      }
    } else if (depth + currentLineDepthChange <= 1) {
      const indent = line.match(/^\s*/)![0]
      output.push(`${indent}}`)
    }

    depth += currentLineDepthChange
  }

  return output.join('\n')
}

// #endregion
