import type {
  LoadOrderIssue,
  ModInfo,
  Profile,
  ResolvedLoadOrder,
} from '../types'
import {
  CORE_PACKAGE_ID,
  PRODUCT_PACKAGE_IDS,
  normalizePackageId,
  packageIdNoSuffix,
  parseVersionTuple,
  compareTuples,
} from './mod-discovery'

export interface ResolveProfileOrderOptions {
  gameVersion: string
  /** player ModsConfig snapshot (diagnostics only) */
  playerActivePackageIds?: string[] | null
}

/**
 * Resolves the dev-time load order for a profile (design doc §6.2):
 * - Core anchored at 0, official DLCs follow in ProductPackageIDs order;
 * - community mods topologically sorted by modDependencies/loadAfter/loadBefore
 *   (Kahn's algorithm with lexicographic tie-break -> deterministic);
 * - dependency cycles are collapsed (SCC, members inlined lexicographically)
 *   and reported as issues instead of failing;
 * - autoOrder=false keeps the declared array order (Core still anchored).
 */
export function resolveProfileOrder(
  discovered: ModInfo[],
  profile: Profile,
  opts: ResolveProfileOrderOptions,
): ResolvedLoadOrder {
  const issues: LoadOrderIssue[] = []
  const byId = new Map<string, ModInfo>()
  for (const mod of discovered) {
    // first definition wins; duplicate packageIds across roots get a warning
    const existing = byId.get(mod.packageId)
    if (existing) {
      existing.warnings.push(`duplicate packageId ${mod.packageId} at ${mod.rootPath}`)
    } else {
      byId.set(mod.packageId, mod)
    }
  }

  // -- vanilla base (Core + optional DLCs), always present and anchored
  const base: ModInfo[] = []
  const core = byId.get(CORE_PACKAGE_ID)
  if (core) base.push(core)
  if (profile.base === 'all-dlc') {
    const dlcs = PRODUCT_PACKAGE_IDS.filter(id => id !== CORE_PACKAGE_ID)
      .map(id => byId.get(id))
      .filter((m): m is ModInfo => m !== undefined)
    base.push(...dlcs)
  }
  const baseIds = new Set(base.map(m => m.packageId))

  // -- community selection
  const selected: ModInfo[] = []
  for (const rawId of profile.mods) {
    const id = normalizePackageId(rawId)
    const mod = byId.get(id)
    if (!mod) {
      issues.push({
        packageId: id,
        kind: 'not-found',
        detail: `packageId "${id}" not found in any mod source; excluded from profile`,
      })
      continue
    }
    if (!isVersionSupported(mod, opts.gameVersion)) {
      issues.push({
        packageId: id,
        kind: 'version-unsupported',
        detail: `mod does not list game version ${opts.gameVersion} in supportedVersions; excluded from profile`,
      })
      continue
    }
    if (baseIds.has(id)) continue // already provided by the vanilla base
    selected.push(mod)
  }

  const activeSet = new Set<string>([
    ...Array.from(baseIds),
    ...selected.map(m => m.packageId),
  ])

  if (!profile.autoOrder) {
    // manual mode: declared order wins (Core still anchored at 0)
    const ordered = [...base, ...selected]
    collectStaticIssues(selected, activeSet, issues)
    return { ordered, issues }
  }

  // -- graph edges (b -> a means "b loads before a")
  const incoming = new Map<string, Set<string>>()
  const ensure = (id: string) => {
    let set = incoming.get(id)
    if (!set) {
      set = new Set()
      incoming.set(id, set)
    }
    return set
  }
  for (const mod of selected) {
    ensure(mod.packageId)
  }

  const addEdge = (before: string, after: string) => {
    if (before === after) return
    if (!activeSet.has(before) || !activeSet.has(after)) return
    ensure(after).add(before)
  }

  for (const mod of selected) {
    for (const dep of mod.dependencies) {
      const depId = packageIdNoSuffix(dep.packageId)
      if (activeSet.has(depId)) addEdge(depId, mod.packageId)
      else {
        issues.push({
          packageId: mod.packageId,
          kind: 'missing-dependency',
          detail: `missing dependency "${dep.packageId}"${dep.displayName ? ` (${dep.displayName})` : ''}`,
        })
      }
    }
    for (const after of mod.loadAfter) {
      addEdge(packageIdNoSuffix(after), mod.packageId)
    }
    for (const before of mod.loadBefore) {
      addEdge(mod.packageId, packageIdNoSuffix(before))
    }
    for (const incompatible of mod.incompatibleWith) {
      const otherId = packageIdNoSuffix(incompatible)
      if (activeSet.has(otherId)) {
        // report once per pair
        if (mod.packageId < otherId) {
          issues.push({
            packageId: mod.packageId,
            kind: 'incompatible-with',
            detail: `incompatible with "${otherId}" but both are in the profile`,
          })
        }
      }
    }
  }

  const ordered = [...base, ...kahnWithSccFallback(selected, incoming, issues)]
  return { ordered, issues }
}

// #region Topological sort with SCC cycle handling

/**
 * Kahn's algorithm over the SCC condensation:
 * - every node belongs to an SCC (singletons for acyclic nodes);
 * - SCCs with no unsatisfied incoming edges are emitted in lexicographic
 *   order of their key (smallest member packageId);
 * - members of one SCC are inlined in lexicographic order and reported as a
 *   cycle issue — mirroring the game's "load anyway" philosophy.
 */
function kahnWithSccFallback(
  nodes: ModInfo[],
  incoming: Map<string, Set<string>>,
  issues: LoadOrderIssue[],
): ModInfo[] {
  const byId = new Map(nodes.map(mod => [mod.packageId, mod]))
  const nodeIds = nodes.map(mod => mod.packageId).sort()

  const sccs = stronglyConnectedComponents(nodeIds, incoming)
  const sccOf = new Map<string, number>()
  sccs.forEach((members, index) => {
    for (const member of members) sccOf.set(member, index)
  })

  const sccKey = (members: string[]) => members[0] // members are sorted
  const sortedSccs = sccs.map(members => Array.from(members).sort())
  const sccIncoming = new Map<number, Set<number>>()
  for (let i = 0; i < sortedSccs.length; i++) sccIncoming.set(i, new Set())
  for (const [afterId, befores] of incoming) {
    const afterScc = sccOf.get(afterId)
    if (afterScc === undefined) continue
    for (const beforeId of befores) {
      const beforeScc = sccOf.get(beforeId)
      if (beforeScc === undefined || beforeScc === afterScc) continue
      sccIncoming.get(afterScc)!.add(beforeScc)
    }
  }

  const emittedScc = new Set<number>()
  const result: ModInfo[] = []
  const remaining = new Set(sortedSccs.map((_, i) => i))

  while (remaining.size > 0) {
    // pick the lexicographically smallest ready SCC (deterministic)
    let best = -1
    for (const index of remaining) {
      const ready = Array.from(sccIncoming.get(index)!).every(dep => emittedScc.has(dep))
      if (ready && (best === -1 || sccKey(sortedSccs[index]) < sccKey(sortedSccs[best]))) {
        best = index
      }
    }
    if (best === -1) throw new Error('load-order: unsatisfiable SCC condensation')

    remaining.delete(best)
    emittedScc.add(best)
    const members = sortedSccs[best]
    if (members.length > 1) {
      issues.push({
        packageId: members[0],
        kind: 'cycle',
        detail: `load-order cycle: ${members.join(' -> ')} (inlined in lexicographic order)`,
      })
    }
    for (const memberId of members) {
      const mod = byId.get(memberId)
      if (mod) result.push(mod)
    }
  }

  return result
}

/** Iterative Tarjan SCC. Returns components with members sorted. */
function stronglyConnectedComponents(
  nodeIds: string[],
  incoming: Map<string, Set<string>>,
): string[][] {
  // operate on out-edges: reverse the incoming map
  const out = new Map<string, Set<string>>()
  for (const id of nodeIds) out.set(id, new Set())
  for (const [afterId, befores] of incoming) {
    for (const beforeId of befores) {
      out.get(beforeId)?.add(afterId)
    }
  }

  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const start of nodeIds) {
    if (index.has(start)) continue

    // frames: [node, iterator position]
    const frames: Array<{ node: string; edges: string[]; pos: number }> = []
    const push = (node: string) => {
      index.set(node, counter)
      low.set(node, counter)
      counter += 1
      stack.push(node)
      onStack.add(node)
      frames.push({ node, edges: Array.from(out.get(node) ?? []), pos: 0 })
    }

    push(start)
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      if (frame.pos < frame.edges.length) {
        const next = frame.edges[frame.pos]
        frame.pos += 1
        if (!index.has(next)) {
          push(next)
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!))
        }
      } else {
        frames.pop()
        if (frames.length > 0) {
          const parent = frames[frames.length - 1].node
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!))
        }
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = []
          for (;;) {
            const member = stack.pop()!
            onStack.delete(member)
            component.push(member)
            if (member === frame.node) break
          }
          component.sort()
          components.push(component)
        }
      }
    }
  }

  return components
}

// #endregion

// #region Static checks (run in both auto and manual order modes)

function collectStaticIssues(
  selected: ModInfo[],
  activeSet: Set<string>,
  issues: LoadOrderIssue[],
): void {
  for (const mod of selected) {
    for (const dep of mod.dependencies) {
      if (!activeSet.has(packageIdNoSuffix(dep.packageId))) {
        issues.push({
          packageId: mod.packageId,
          kind: 'missing-dependency',
          detail: `missing dependency "${dep.packageId}"${dep.displayName ? ` (${dep.displayName})` : ''}`,
        })
      }
    }
    for (const incompatible of mod.incompatibleWith) {
      const otherId = packageIdNoSuffix(incompatible)
      if (activeSet.has(otherId) && mod.packageId < otherId) {
        issues.push({
          packageId: mod.packageId,
          kind: 'incompatible-with',
          detail: `incompatible with "${otherId}" but both are in the profile`,
        })
      }
    }
  }
}

// #endregion

function isVersionSupported(mod: ModInfo, gameVersion: string): boolean {
  if (mod.supportedVersions.length === 0) return true // don't block legacy mods
  const wanted = parseVersionTuple(gameVersion)
  if (!wanted) return true
  // the game compares supportedVersions by major.minor only
  // (VersionControl.SameVersion)
  return mod.supportedVersions.some(v => {
    const tuple = parseVersionTuple(v)
    return tuple !== undefined && tuple[0] === wanted[0] && tuple[1] === wanted[1]
  })
}
