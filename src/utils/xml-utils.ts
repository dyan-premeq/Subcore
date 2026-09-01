import { XMLParser } from 'fast-xml-parser'
import XMLBuilder from 'fast-xml-builder'

/**
 * RimWorld XML may legally contain elements named like JS prototype hazards
 * (e.g. <constructor> in asel.monolynrace). fast-xml-parser v5 hard-rejects
 * those tag names, so rename them on the way in and restore them on the way
 * out. Placeholder names are chosen to be collision-safe.
 */
const CRITICAL_TAG_PLACEHOLDER: Record<string, string> = {
  __proto__: 'rimSageDunderProto',
  constructor: 'rimSageConstructor',
  prototype: 'rimSagePrototype',
}

function restoreCriticalTags(xml: string): string {
  return xml.replace(
    /<(\/?)(rimSageDunderProto|rimSageConstructor|rimSagePrototype)(?=[\s/>])/g,
    (_m, slash: string, name: string) => {
      const original = Object.entries(CRITICAL_TAG_PLACEHOLDER).find(
        ([, v]) => v === name,
      )![0]
      return `<${slash}${original}`
    },
  )
}

export const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: false,
  transformTagName: (name: string) => CRITICAL_TAG_PLACEHOLDER[name] ?? name,
  isArray: (tag, path, _, isAttribute) => {
    if (isAttribute) return false
    if (tag === 'li') return true

    // Defs first-level child (game: one def per node). Equality, not segment
    // counting: namespace-qualified def tags contain dots themselves
    // (e.g. <AlienRace.ThingDef_AlienRace> -> path "Defs.AlienRace.ThingDef_AlienRace"),
    // and deeper nesting ("Defs.X.Y") never equals "Defs." + tag.
    return path.toString() === 'Defs.' + tag
  },
})

export const builder = new XMLBuilder({
  ignoreAttributes: false,
  format: true,
})

/** builder.build() with critical tag names restored (see above). */
export function buildXml(value: unknown): string {
  return restoreCriticalTags(builder.build(value) as string)
}
