import type { Def } from '../types'
import { isMayRequireSatisfied } from './def-resolver'
import type { XmlConditions } from './xml-conditions'
import { parser } from './xml-utils'

/** The raw and post-patch XML passes use the same top-level Def load conditions. */
export function parseDefNodes(xml: string, active: ReadonlySet<string>, conditions?: XmlConditions) {
  const nodes: { def: Def; defType: string }[] = []
  let skipped = 0
  const root = parser.parse(xml).Defs as Record<string, unknown> | undefined
  if (root) {
    if (conditions) collectRequirements(root, conditions)
    for (const [defType, values] of Object.entries(root)) {
      if (!Array.isArray(values)) continue
      for (const def of values as Def[]) {
        if (!def || typeof def !== 'object') continue
        if (isMayRequireSatisfied(def['@_MayRequire'], def['@_MayRequireAnyOf'], active)) {
          nodes.push({ def: Object.assign({ defType }, def), defType })
        } else {
          skipped++
        }
      }
    }
  }
  return { nodes, skipped }
}

function collectRequirements(node: object, conditions: XmlConditions) {
  const fields = node as Record<string, unknown>
  const all = fields['@_MayRequire']
  const any = fields['@_MayRequireAnyOf']
  if (typeof all === 'string' || typeof any === 'string') {
    conditions.require(typeof all === 'string' ? all : undefined, typeof any === 'string' ? any : undefined)
  }
  for (const value of Object.values(fields)) {
    if (value && typeof value === 'object') collectRequirements(value, conditions)
  }
}
