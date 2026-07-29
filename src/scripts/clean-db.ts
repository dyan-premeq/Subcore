import { rm } from 'node:fs/promises'
import { indexDbPath } from '../utils/env'

await rm(indexDbPath, { force: true })

console.log('Clean complete. Run "bun run build" to rebuild.')
