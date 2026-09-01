import { describe, expect, test } from 'bun:test'

// Exercises the real MCP handshake over stdio: spawn `bun src/stdio.ts` as a
// subprocess, run initialize -> notifications/initialized -> tools/list, and
// assert on the JSON-RPC response for id 2.

// registration order from src/server.ts registerTools()
const EXPECTED_TOOLS = [
  'search_source',
  'read_file',
  'list_directory',
  'get_def_details',
  'search_defs',
  'read_csharp_symbol',
  'list_mods',
  'search_patches',
  'search_harmony',
]

const TOOLS_WITH_OUTPUT_SCHEMA = new Set([
  'list_directory',
  'get_def_details',
  'search_defs',
  'list_mods',
  'search_patches',
  'search_harmony',
])

describe('tools/list over stdio', () => {
  test(
    'registers the nine read-only tools in order with titles and output schemas',
    async () => {
      const proc = Bun.spawn(['bun', 'src/stdio.ts'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      })

      try {
        const messages = [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2026-07-28',
              capabilities: {},
              clientInfo: { name: 'test', version: '0' },
            },
          },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]
        proc.stdin.write(messages.map(m => JSON.stringify(m) + '\n').join(''))
        proc.stdin.flush()

        const reader = proc.stdout.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let response: { error?: unknown; result?: { tools?: unknown[] } } | undefined

        while (!response) {
          const { done, value } = await reader.read()
          if (done) throw new Error('server exited before answering tools/list')
          buffer += decoder.decode(value, { stream: true })

          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line) continue
            const msg = JSON.parse(line)
            if (msg.id === 2) {
              response = msg
              break
            }
          }
        }

        expect(response.error).toBeUndefined()
        const tools = response.result!.tools as Array<{
          name: string
          title?: unknown
          annotations?: { readOnlyHint?: unknown; openWorldHint?: unknown }
          outputSchema?: { type?: unknown }
        }>

        expect(tools.map(t => t.name)).toEqual(EXPECTED_TOOLS)

        for (const tool of tools) {
          expect(tool.annotations!.readOnlyHint).toBe(true)
          expect(tool.annotations!.openWorldHint).toBe(false)
          expect(typeof tool.title).toBe('string')
          expect(tool.title).not.toBe('')

          if (TOOLS_WITH_OUTPUT_SCHEMA.has(tool.name)) {
            expect(tool.outputSchema!.type).toBe('object')
          }
        }
      } finally {
        proc.kill()
      }
    },
    60_000,
  )
})
