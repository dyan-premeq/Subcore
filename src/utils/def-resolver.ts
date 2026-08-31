import type { Def, XmlNode, XmlObject } from '../types'
import { compareStrings } from './compare'

export function processDefs(defs: Def[]): Def[] {
  const resolver = new DefResolver(defs)
  return defs.map(def => resolver.resolve(def))
}

// #region Helpers
class DefResolver {
  private readonly defMap = new Map<string, Def>()
  private readonly memo = new Map<string, Def>()

  constructor(defs: Def[]) {
    defs.forEach(def => {
      if (def['@_Name']) {
        this.defMap.set(def['@_Name'], def)
      }
    })
  }

  public resolve(def: Def): Def {
    if (!def['@_ParentName']) return sortDefKeys(def)

    const parentResolved = this.resolveByName(def['@_ParentName'], new Set())
    if (parentResolved === undefined) {
      // game tolerance (XmlInheritance.GetBestParentFor): a missing parent is
      // a logged error, not a crash — the def is deserialized as a root
      console.warn(
        `[def-resolver] parent "${def['@_ParentName']}" not found for def "${def.defName ?? '?'}"; treating as root`,
      )
      return sortDefKeys(def)
    }
    const merged = mergeNodes(stripParentMeta(parentResolved), def) as Def
    return sortDefKeys(merged)
  }

  private resolveByName(name: string, stack: Set<string>): Def | undefined {
    if (this.memo.has(name)) return this.memo.get(name)

    if (stack.has(name)) {
      // cycle: keep the node unresolved instead of throwing (game tolerance)
      console.warn(`[def-resolver] circular inheritance: ${Array.from(stack).join(' -> ')} -> ${name}`)
      return undefined
    }

    const rawDef = this.defMap.get(name)
    if (!rawDef) {
      return undefined
    }

    const parentName = rawDef['@_ParentName']
    let resolvedDef: Def

    if (parentName) {
      const parentStack = new Set(stack).add(name)
      const parent = this.resolveByName(parentName, parentStack)
      // missing/cyclic grandparent: fall back to the raw parent definition
      resolvedDef = parent !== undefined ? (mergeNodes(stripParentMeta(parent), rawDef) as Def) : rawDef
    } else {
      resolvedDef = rawDef
    }

    this.memo.set(name, resolvedDef)
    return resolvedDef
  }
}

function stripParentMeta(def: Def): Def {
  const { '@_Name': _n, '@_Abstract': _a, '@_ParentName': _p, ...rest } = def
  return rest
}

function mergeNodes(parent: XmlNode, child: XmlNode): XmlNode {
  if (child === undefined || child === null) return parent
  if (parent === undefined || parent === null) return child

  if (Array.isArray(parent) && Array.isArray(child)) {
    return [...parent, ...child]
  }

  if (isXmlObject(parent) && isXmlObject(child)) {
    const inheritAttr = child['@_Inherit'] as string | undefined
    if (inheritAttr?.toLowerCase() === 'false') return child

    const allKeys = new Set([...Object.keys(parent), ...Object.keys(child)])
    const result: XmlObject = {}

    for (const key of allKeys) {
      result[key] = mergeNodes(parent[key], child[key])
    }

    return result
  }

  return child
}

function sortDefKeys(def: Def): Def {
  const priorityKeys = ['defName', 'label', 'description']
  const sorted: Def = {}

  const keys = Object.keys(def).sort((a, b) => {
    const idxA = priorityKeys.indexOf(a)
    const idxB = priorityKeys.indexOf(b)

    if (idxA !== -1 && idxB !== -1) return idxA - idxB
    if (idxA !== -1) return -1
    if (idxB !== -1) return 1

    return compareStrings(a, b)
  })

  keys.forEach(key => (sorted[key] = def[key]))

  return sorted
}

function isXmlObject(item: unknown): item is XmlObject {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item)
}
// #endregion
