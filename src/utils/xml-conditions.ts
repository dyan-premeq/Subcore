import { isMayRequireSatisfied } from './def-resolver'
import { packageIdNoSuffix } from './mod-discovery'
import type { ModInfo } from '../types'

/** Record authored and post-patch requirements (including dormant nodes) and executed FindMod branches. */
export class XmlConditions {
  private readonly requirements = new Set<string>()
  private readonly names = new Set<string>()

  require(all?: string, any?: string) {
    this.requirements.add(JSON.stringify([all ?? '', any ?? '']))
  }

  findMod(names: string[]) {
    this.names.add(JSON.stringify(names))
  }

  snapshot(): XmlPredicates {
    return {
      require: [...this.requirements].map(key => JSON.parse(key)),
      findMod: [...this.names].map(key => JSON.parse(key)),
    }
  }
}

export interface XmlPredicates {
  require: [string, string][]
  findMod: string[][]
}

export function conditionResults(predicates: XmlPredicates, mods: ModInfo[]): boolean[] {
  const ids = new Set(mods.map(mod => packageIdNoSuffix(mod.packageId)))
  const names = new Set(mods.map(mod => mod.name))
  return [
    ...predicates.require.map(([all, any]) => isMayRequireSatisfied(all, any, ids)),
    ...predicates.findMod.map(group => group.some(name => names.has(name))),
  ]
}
