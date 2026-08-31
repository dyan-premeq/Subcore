import { rm } from 'node:fs/promises'
import { indexDbPath } from '../utils/env'

// Note: dist/mods-manifest.json is intentionally preserved — it is produced
// by import-mods and consumed by index-mods/index-defs/server tools.
await rm(indexDbPath, { force: true })

console.log('Clean complete. Run "bun run build" to rebuild.')
