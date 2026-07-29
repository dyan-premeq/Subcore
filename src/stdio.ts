import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createServer } from './server'

serveStdio(createServer)

console.error('\x1b[32m%s\x1b[0m', 'RimSage MCP running...')
