import { parseArgs } from 'node:util'
import { syncProfile } from '../sync/profile'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true,
  options: {
    'from-game-config': { type: 'boolean' }, full: { type: 'boolean' },
    profile: { type: 'string' }, 'mods-config': { type: 'string' },
    'workshop-root': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
})
if (values.help) {
  console.log('bun run sync [gameRoot] [--from-game-config] [--full] [--profile path] [--mods-config path] [--workshop-root path]')
} else {
  if (positionals.length > 1) throw new Error('Expected at most one game root.')
  const result = await syncProfile({
    gameRoot: positionals[0], full: values.full, fromGameConfig: values['from-game-config'],
    profilePath: values.profile, modsConfigPath: values['mods-config'], workshopRoot: values['workshop-root'],
  })
  console.log(JSON.stringify(result))
}
