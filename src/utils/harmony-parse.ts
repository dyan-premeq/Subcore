// Static Harmony-patch extraction from C# source text (mod Source/ and
// decompiled assemblies). Design doc §6.7: three statically parseable
// patterns; anything runtime-resolved is recorded as targetType='dynamic'.
//
//  1. attribute patches: [HarmonyPatch(typeof(T), "M")] above a class
//     (stacked attributes merge; nameof(...) counts as static),
//  2. harmony.PatchAll() calls -> one '*Assembly*' marker row per file,
//  3. manual calls: AccessTools.Method(typeof(T), "M") in files that also
//     contain a .Patch( call (prefix/postfix kinds are not extracted — read
//     the source for those).

export interface HarmonyPatchRecord {
  patchClass: string | null
  targetType: string | null
  targetMethod: string | null
  prefix: boolean
  postfix: boolean
  transpiler: boolean
  finalizer: boolean
}

const CLASS_REGEX =
  /^\s*(?:public|private|protected|internal|abstract|sealed|static|partial|readonly|unsafe|\s)*\s+(?:class|struct|interface|enum)\s+([a-zA-Z0-9_]+)/

const PATCH_ALL_REGEX = /\.PatchAll\s*\(/
const MANUAL_CALL_REGEX = /\.Patch\s*\(/
const MANUAL_TARGET_REGEX =
  /AccessTools\.Method\(\s*typeof\(\s*([\w.]+?)\s*\)\s*,\s*"([^"]*)"/g
const TYPEOF_REGEX = /typeof\(\s*([\w.]+?)\s*\)/
const STRING_ARG_REGEX = /"([^"]+)"/
const NAMEOF_REGEX = /\bnameof\(\s*([\w.]+?)\s*\)/

const FLAG_REGEX = {
  prefix: /\[HarmonyPrefix\b/,
  postfix: /\[HarmonyPostfix\b/,
  transpiler: /\[HarmonyTranspiler\b/,
  finalizer: /\[HarmonyFinalizer\b/,
} as const

// Harmony also infers the kind from the method NAME alone (no attribute):
// `static bool Prefix(...)` inside a patch class (seen in the wild: VEF).
const NAME_CONVENTION_REGEX = {
  prefix: /^\s*(?:public|private|internal|protected|static|extern|unsafe|\s)+[\w.<>,?[\]]+\s+Prefix\s*\(/m,
  postfix: /^\s*(?:public|private|internal|protected|static|extern|unsafe|\s)+[\w.<>,?[\]]+\s+Postfix\s*\(/m,
  transpiler:
    /^\s*(?:public|private|internal|protected|static|extern|unsafe|\s)+[\w.<>,?[\]]+\s+Transpiler\s*\(/m,
  finalizer:
    /^\s*(?:public|private|internal|protected|static|extern|unsafe|\s)+[\w.<>,?[\]]+\s+Finalizer\s*\(/m,
} as const

function blankRecord(): HarmonyPatchRecord {
  return {
    patchClass: null,
    targetType: null,
    targetMethod: null,
    prefix: false,
    postfix: false,
    transpiler: false,
    finalizer: false,
  }
}

export function extractHarmonyPatches(content: string): HarmonyPatchRecord[] {
  const lines = content.split(/\r?\n/)
  const records: HarmonyPatchRecord[] = []
  const hasManualCall = MANUAL_CALL_REGEX.test(content)

  let attrBuffer: string[] = []
  let attrOpen = false // mid multi-line attribute
  let lastClass: string | null = null
  let patchAllSeen = false

  lines.forEach((line, index) => {
    const trimmed = line.trim()

    // attribute lines accumulate directly above the declaration they adorn
    if (attrOpen || trimmed.startsWith('[')) {
      attrBuffer.push(trimmed)
      attrOpen = !bracketBalanced(attrBuffer.join(' '))
      return
    }

    const classMatch = trimmed.match(CLASS_REGEX)
    if (classMatch) {
      const attrText = attrBuffer.join(' ')
      attrBuffer = []
      if (attrText.includes('HarmonyPatch')) {
        records.push(parseAttributePatch(attrText, classMatch[1], lines, index))
      }
      lastClass = classMatch[1]
      return
    }

    // a non-attribute code line separates attributes from any later class
    if (trimmed !== '') attrBuffer = []

    if (!patchAllSeen && PATCH_ALL_REGEX.test(line)) {
      const record = blankRecord()
      record.patchClass = lastClass
      record.targetType = '*Assembly*'
      records.push(record)
      patchAllSeen = true
    }

    if (hasManualCall) {
      collectManualTargets(line, lastClass, records)
    }
  })

  return records
}

function collectManualTargets(
  line: string,
  patchClass: string | null,
  records: HarmonyPatchRecord[],
): void {
  MANUAL_TARGET_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MANUAL_TARGET_REGEX.exec(line)) !== null) {
    const [typeName, method] = [match[1], match[2]]
    if (
      records.some(
        record => record.targetType === typeName && record.targetMethod === method,
      )
    ) {
      continue
    }
    const record = blankRecord()
    record.patchClass = patchClass
    record.targetType = typeName
    record.targetMethod = method
    records.push(record)
  }
}

function parseAttributePatch(
  attrText: string,
  className: string,
  lines: string[],
  classLine: number,
): HarmonyPatchRecord {
  const record = blankRecord()
  record.patchClass = className

  const typeofMatch = attrText.match(TYPEOF_REGEX)
  if (typeofMatch) record.targetType = typeofMatch[1]

  const stringMatch = attrText.match(STRING_ARG_REGEX)
  if (stringMatch) {
    record.targetMethod = stringMatch[1]
  } else {
    const nameofMatch = attrText.match(NAMEOF_REGEX)
    if (nameofMatch) {
      record.targetMethod = nameofMatch[1].split('.').pop()!
    }
  }

  if (!record.targetType) record.targetType = 'dynamic'

  const body = classBodyText(lines, classLine)
  record.prefix = FLAG_REGEX.prefix.test(body) || NAME_CONVENTION_REGEX.prefix.test(body)
  record.postfix = FLAG_REGEX.postfix.test(body) || NAME_CONVENTION_REGEX.postfix.test(body)
  record.transpiler =
    FLAG_REGEX.transpiler.test(body) || NAME_CONVENTION_REGEX.transpiler.test(body)
  record.finalizer =
    FLAG_REGEX.finalizer.test(body) || NAME_CONVENTION_REGEX.finalizer.test(body)

  return record
}

function classBodyText(lines: string[], startLine: number): string {
  const body: string[] = []
  let depth = 0
  let foundBrace = false

  for (let i = startLine; i < lines.length; i++) {
    body.push(lines[i])
    for (const char of lines[i]) {
      if (char === '{') {
        depth += 1
        foundBrace = true
      }
      if (char === '}') depth -= 1
    }

    if (foundBrace && depth <= 0) break
    if (!foundBrace && lines[i].trim().endsWith(';')) break
  }

  return body.join('\n')
}

function bracketBalanced(text: string): boolean {
  let depth = 0
  for (const char of text) {
    if (char === '[') depth += 1
    if (char === ']') depth -= 1
  }
  return depth === 0
}
