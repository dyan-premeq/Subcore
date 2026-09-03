import type { Def, XmlNode, XmlObject } from '../types'
import { compareStrings } from './compare'

/**
 * One indexed def plus the context Verse.XmlInheritance needs.
 */
export interface DefEntry {
  def: Def
  defType: string
  modId: number
  loadOrder: number
}

/** Row for the def_names registry table: @Name → defining mod. */
export interface NameRegistration {
  name: string
  modId: number
  loadOrder: number
  defType: string
  /** abstract templates have no defName */
  defName: string | null
}

export type DefResolveIssueKind = 'missing-parent' | 'cycle' | 'duplicate-name'

export interface DefResolveIssue {
  kind: DefResolveIssueKind
  /** the @Name / @ParentName involved */
  name: string
  modId: number
  loadOrder: number
  defName: string | null
  detail: string
}

export interface DefResolution {
  /** same order as the input entries */
  resolved: Def[]
  nameRegistry: NameRegistration[]
  issues: DefResolveIssue[]
}

/**
 * XML inheritance with the semantics of Verse.XmlInheritance:
 * best parent = same-@Name candidate with the highest loadOrder ≤ the child's,
 * same-mod duplicate names are rejected, missing parents / cycles degrade to
 * raw nodes instead of throwing, child attributes fully replace parent ones.
 */
export function processDefs(entries: DefEntry[]): DefResolution {
  const resolver = new DefResolver(entries)
  return {
    resolved: entries.map(entry => resolver.resolve(entry)),
    nameRegistry: resolver.nameRegistry,
    issues: resolver.issues,
  }
}

// #region MayRequire

/**
 * Node-level load condition: MayRequire = every listed packageId must be
 * active, MayRequireAnyOf = at least one. Matching is case-insensitive and
 * ignores `|postfix` suffixes (game: GetActiveModWithIdentifier(ignorePostfix)).
 */
export function isMayRequireSatisfied(
  mayRequire: string | undefined,
  mayRequireAnyOf: string | undefined,
  activePackageIds: ReadonlySet<string>,
): boolean {
  const isActive = (raw: string): boolean =>
    activePackageIds.has(raw.trim().toLowerCase().split('|')[0]!)

  if (mayRequire && !mayRequire.split(',').every(isActive)) return false
  if (mayRequireAnyOf && !mayRequireAnyOf.split(',').some(isActive)) return false
  return true
}

// #endregion

interface Candidate {
  modId: number
  loadOrder: number
  def: Def
}

type ParentResolution =
  | { kind: 'resolved'; def: Def }
  | { kind: 'missing' }
  // rawDef: the cycle member's as-authored def, for callers above the cycle
  | { kind: 'cycle'; members: ReadonlySet<string>; rawDef?: Def }

class DefResolver {
  readonly nameRegistry: NameRegistration[] = []
  readonly issues: DefResolveIssue[] = []

  /** @Name → candidates sorted by loadOrder asc (at most one per mod) */
  private readonly registry = new Map<string, Candidate[]>()
  private readonly reportedMissing = new Set<string>()
  private readonly reportedCycles = new Set<string>()

  constructor(entries: DefEntry[]) {
    for (const entry of entries) {
      const name = entry.def['@_Name']
      if (!name) continue

      const candidates = this.registry.get(name) ?? []
      if (candidates.some(candidate => candidate.modId === entry.modId)) {
        // game (XmlInheritance.TryRegister): same-mod duplicate Name → error,
        // the node is not registered (first registration wins)
        this.issues.push({
          kind: 'duplicate-name',
          name,
          modId: entry.modId,
          loadOrder: entry.loadOrder,
          defName: entry.def.defName ?? null,
          detail: `duplicate @Name "${name}" inside one mod; keeping the first registration`,
        })
        continue
      }
      candidates.push({ modId: entry.modId, loadOrder: entry.loadOrder, def: entry.def })
      candidates.sort((a, b) => a.loadOrder - b.loadOrder || a.modId - b.modId)
      this.registry.set(name, candidates)

      this.nameRegistry.push({
        name,
        modId: entry.modId,
        loadOrder: entry.loadOrder,
        defType: entry.defType,
        defName: entry.def.defName ?? null,
      })
    }
  }

  resolve(entry: DefEntry): Def {
    const def = entry.def
    const parentName = def['@_ParentName']
    if (!parentName) return sortDefKeys(stripInheritanceAttrs(def))

    const ownName = def['@_Name']
    const parent = this.resolveParent(parentName, entry.loadOrder, ownName ? [ownName] : [])

    if (parent.kind === 'missing') {
      // game (GetBestParentFor): missing parent is a logged error, not a
      // crash — the def deserializes as a root node
      this.pushMissing(parentName, {
        modId: entry.modId,
        loadOrder: entry.loadOrder,
        defName: entry.def.defName ?? null,
      })
      return sortDefKeys(stripInheritanceAttrs(def))
    }
    if (parent.kind === 'cycle') {
      this.pushCycle(parent.members, {
        modId: entry.modId,
        loadOrder: entry.loadOrder,
        defName: entry.def.defName ?? null,
      })
      if (ownName && parent.members.has(ownName)) {
        // cycle member: the def stays as authored (game: node unresolved)
        return sortDefKeys(stripInheritanceAttrs(def))
      }
      // above the cycle: merge with the unresolved (raw) parent
      const merged = mergeNodes(parent.rawDef!, def) as Def
      return sortDefKeys(stripInheritanceAttrs(merged))
    }

    const merged = mergeNodes(parent.def, def) as Def
    return sortDefKeys(stripInheritanceAttrs(merged))
  }

  /**
   * Resolve the parent candidate for `name` as seen from a node at `limit`
   * (game GetBestParentFor: highest loadOrder ≤ limit), recursing through the
   * candidate's own ancestry.
   */
  private resolveParent(name: string, limit: number, stack: string[]): ParentResolution {
    const duplicateAt = stack.indexOf(name)
    if (duplicateAt !== -1) {
      return { kind: 'cycle', members: new Set(stack.slice(duplicateAt)) }
    }

    const best = bestCandidate(this.registry.get(name) ?? [], limit)
    if (!best) return { kind: 'missing' }

    const parentDef = best.def
    const grandParentName = parentDef['@_ParentName']
    if (!grandParentName) return { kind: 'resolved', def: parentDef }

    const up = this.resolveParent(grandParentName, best.loadOrder, [...stack, name])
    const context = {
      modId: best.modId,
      loadOrder: best.loadOrder,
      defName: parentDef.defName ?? null,
    }

    if (up.kind === 'missing') {
      // game: unresolved ancestor falls back to the original node
      this.pushMissing(grandParentName, context)
      return { kind: 'resolved', def: parentDef }
    }
    if (up.kind === 'cycle') {
      this.pushCycle(up.members, context)
      if (up.members.has(name)) {
        // this node is part of the cycle: stays raw (unresolved)
        return { kind: 'cycle', members: up.members, rawDef: parentDef }
      }
      return { kind: 'resolved', def: parentDef }
    }

    return { kind: 'resolved', def: mergeNodes(up.def, parentDef) as Def }
  }

  private pushMissing(
    name: string,
    context: { modId: number; loadOrder: number; defName: string | null },
  ): void {
    const key = `${name}@${context.loadOrder}`
    if (this.reportedMissing.has(key)) return
    this.reportedMissing.add(key)
    this.issues.push({
      kind: 'missing-parent',
      name,
      ...context,
      detail: `parent "${name}" not found at loadOrder <= ${context.loadOrder}; treating the def as a root node`,
    })
  }

  private pushCycle(
    members: ReadonlySet<string>,
    context: { modId: number; loadOrder: number; defName: string | null },
  ): void {
    const key = Array.from(members).sort().join('->')
    if (this.reportedCycles.has(key)) return
    this.reportedCycles.add(key)
    this.issues.push({
      kind: 'cycle',
      name: key,
      ...context,
      detail: `circular inheritance: ${key}; nodes fall back to their raw definitions`,
    })
  }
}

function bestCandidate(candidates: Candidate[], limit: number): Candidate | undefined {
  let best: Candidate | undefined
  for (const candidate of candidates) {
    if (candidate.loadOrder > limit) break
    best = candidate
  }
  return best
}

// #region Merge (game: RecursiveNodeCopyOverwriteElements)

const INHERITANCE_ATTRS = new Set(['@_Name', '@_ParentName', '@_Abstract', '@_Inherit'])

/** Remove the inheritance machinery attributes from a resolved def. */
function stripInheritanceAttrs<T extends XmlNode>(node: T): T {
  if (!isXmlObject(node)) return node
  const result: XmlObject = {}
  for (const [key, value] of Object.entries(node)) {
    if (!INHERITANCE_ATTRS.has(key)) result[key] = value
  }
  return result as T
}

function mergeNodes(parent: XmlNode, child: XmlNode): XmlNode {
  // empty child element: keep the parent's children (game rule)
  if (child === undefined || child === null || child === '') return parent
  if (parent === undefined || parent === null) return child

  // <li> lists append (game: XmlInheritanceAllowDuplicate fields)
  if (Array.isArray(parent) && Array.isArray(child)) return [...parent, ...child]

  if (isXmlObject(parent) && isXmlObject(child)) {
    const inherit = child['@_Inherit']
    if (typeof inherit === 'string' && inherit.toLowerCase() === 'false') {
      // Inherit=false: discard the parent's content entirely; the Inherit
      // marker itself must not leak into the result
      const { '@_Inherit': _drop, ...rest } = child
      return rest
    }

    const childText = child['#text']
    if (typeof childText === 'string') {
      // child has a text value: all of the parent's child nodes are dropped
      const result: XmlObject = { '#text': childText }
      for (const [key, value] of Object.entries(child)) {
        if (key.startsWith('@_')) result[key] = value
      }
      return result
    }

    const result: XmlObject = {}

    // attributes: the child's attribute set fully replaces the parent's
    for (const [key, value] of Object.entries(child)) {
      if (key.startsWith('@_')) result[key] = value
    }
    const text = child['#text'] ?? parent['#text']
    if (text !== undefined) result['#text'] = text

    // elements: same-name recursion; parent-only elements are kept
    for (const [key, value] of Object.entries(parent)) {
      if (key.startsWith('@_') || key === '#text') continue
      const childValue = child[key]
      result[key] = childValue === undefined ? value : mergeNodes(value, childValue)
    }
    // child-only elements append
    for (const [key, value] of Object.entries(child)) {
      if (key.startsWith('@_') || key === '#text') continue
      if (result[key] === undefined) result[key] = value
    }
    return result
  }

  return child
}

// #endregion

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
