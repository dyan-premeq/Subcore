import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  checkProfileGameVersion,
  loadProfile,
  parseModsConfig,
  parseProfile,
  profileFromModsConfig,
  readPlayerActiveMods,
} from '../../src/utils/profile'

describe('profile', () => {
  test('missing file or garbage falls back to vanilla-only', () => {
    const missing = loadProfile(join(import.meta.dir, 'does-not-exist.json'))
    expect(missing.exists).toBe(false)
    expect(missing.profile.mods).toEqual([])

    const warnings: string[] = []
    const garbage = parseProfile('nope', warnings)
    expect(garbage.base).toBe('all-dlc')
    expect(warnings.length).toBeGreaterThan(0)
  })

  test('parses a profile: lowercases, dedupes, defaults autoOrder', () => {
    const profile = parseProfile({
      name: 've-compat-dev',
      base: 'core-only',
      mods: ['VanillaExpanded.Framework', 'mehni.pickupandhaul', 'mehni.pickupandhaul'],
    })
    expect(profile.base).toBe('core-only')
    expect(profile.mods).toEqual(['vanillaexpanded.framework', 'mehni.pickupandhaul'])
    expect(profile.autoOrder).toBe(true)
  })

  test('parses ModsConfig activeMods in order', () => {
    const xml = `
      <ModsConfigData>
        <activeMods>
          <li>brrainz.harmony</li>
          <li>ludeon.rimworld</li>
          <li>beta.core</li>
        </activeMods>
      </ModsConfigData>
    `
    expect(parseModsConfig(xml)).toEqual(['brrainz.harmony', 'ludeon.rimworld', 'beta.core'])
  })

  test('snapshots a game config (vanilla stripped, order kept, autoOrder=false)', () => {
    const profile = profileFromModsConfig([
      'brrainz.harmony',
      'ludeon.rimworld',
      'ludeon.rimworld.royalty',
      'beta.core',
      'alpha.tools',
    ])
    expect(profile.autoOrder).toBe(false)
    expect(profile.mods).toEqual(['brrainz.harmony', 'beta.core', 'alpha.tools'])
  })

  test('reads the player ModsConfig from an explicit path', () => {
    const modsConfig = join(import.meta.dir, '../fixtures/game-root/ModsConfig.xml')
    const active = readPlayerActiveMods(modsConfig)
    expect(active?.[0]).toBe('brrainz.harmony')
    expect(active).toContain('gamma.conditional')
  })

  test('checkProfileGameVersion warns on major.minor mismatch only', () => {
    // no declaration -> silent
    expect(checkProfileGameVersion(parseProfile({ mods: [] }), '1.6.4871')).toBeUndefined()
    // same major.minor, different build -> fine
    expect(
      checkProfileGameVersion(parseProfile({ mods: [], gameVersion: '1.6' }), '1.6.4871'),
    ).toBeUndefined()
    // different minor -> mismatch
    const mismatch = checkProfileGameVersion(
      parseProfile({ mods: [], gameVersion: '1.5' }),
      '1.6.4871',
    )
    expect(mismatch).toContain('does not match game version 1.6.4871')
    // unparseable declaration
    const invalid = checkProfileGameVersion(
      parseProfile({ mods: [], gameVersion: 'abc' }),
      '1.6.4871',
    )
    expect(invalid).toContain('not a valid version')
  })
})
