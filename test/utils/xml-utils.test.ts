import { describe, expect, test } from 'bun:test'
import { builder, parser } from '../../src/utils/xml-utils'

describe('xml-utils', () => {
  test('parses Def collections, list items, and inheritance attributes', () => {
    const xml =
      '<Defs><ThingDef Name="Base"><li>a</li><li>b</li></ThingDef><ThingDef ParentName="Base" Inherit="false"><defName>Child</defName></ThingDef></Defs>'
    const result = parser.parse(xml)

    expect(result.Defs.ThingDef).toEqual([
      { '@_Name': 'Base', li: ['a', 'b'] },
      {
        '@_ParentName': 'Base',
        '@_Inherit': 'false',
        defName: 'Child',
      },
    ])
  })

  test('wraps namespace-qualified def tags in arrays, repeated or single', () => {
    // the dot inside the tag used to break the "Defs first-level child" check
    const xml =
      '<Defs>' +
      '<ThingDef><defName>Plain</defName></ThingDef>' +
      '<AlienRace.ThingDef_AlienRace><defName>First</defName></AlienRace.ThingDef_AlienRace>' +
      '<AlienRace.ThingDef_AlienRace><defName>Second</defName></AlienRace.ThingDef_AlienRace>' +
      '</Defs>'
    const result = parser.parse(xml)

    // regression: plain tags still become arrays
    expect(result.Defs.ThingDef).toEqual([{ defName: 'Plain' }])
    expect(result.Defs['AlienRace.ThingDef_AlienRace']).toEqual([
      { defName: 'First' },
      { defName: 'Second' },
    ])

    const solo = parser.parse(
      '<Defs><FlavorText.FlavorDef><defName>Solo</defName></FlavorText.FlavorDef></Defs>',
    )
    expect(solo.Defs['FlavorText.FlavorDef']).toEqual([{ defName: 'Solo' }])
  })

  test('nested elements never become arrays (equal-value criterion, no false positives)', () => {
    const xml =
      '<Defs><ThingDef><comps><li><compClass>Foo</compClass></li></comps>' +
      '<nested><child><grandchild>x</grandchild></child></nested></ThingDef></Defs>'
    const result = parser.parse(xml)
    const def = result.Defs.ThingDef[0]

    // comps stays an object; only the li rule makes its children an array
    expect(Array.isArray(def.comps)).toBe(false)
    expect(def.comps.li).toEqual([{ compClass: 'Foo' }])
    // Defs.X.Y.grandchild: old criterion (segment count) and new one (equality)
    // both reject it
    expect(Array.isArray(def.nested.child)).toBe(false)
    expect(def.nested.child.grandchild).toBe('x')
  })

  test('preserves Def structure through an XML round trip', () => {
    const defs = {
      Defs: {
        ThingDef: [
          { '@_Name': 'Base', defName: 'BaseThing', li: ['a', 'b'] },
          {
            '@_ParentName': 'Base',
            '@_Inherit': 'false',
            defName: 'ChildThing',
          },
        ],
      },
    }

    expect(parser.parse(builder.build(defs))).toEqual(defs)
  })
})
