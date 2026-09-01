import { describe, expect, test } from 'bun:test'

// Exercises the real MCP handshake over stdio: spawn `bun src/stdio.ts` as a
// subprocess, run initialize -> notifications/initialized -> tools/list, and
// assert on the JSON-RPC response for id 2. Then a tools/call with an unknown
// argument must fail input validation before the handler ever runs.

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
  'find_refs',
]

const TOOLS_WITH_OUTPUT_SCHEMA = new Set([
  'list_directory',
  'get_def_details',
  'search_defs',
  'list_mods',
  'search_patches',
  'search_harmony',
  'find_refs',
])

describe('tools/list over stdio', () => {
  test(
    'registers the ten read-only tools in order with titles and output schemas',
    async () => {
      const proc = Bun.spawn(['bun', 'src/stdio.ts'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      })

      try {
        const nextMessage = lineReader(proc)

        proc.stdin.write(
          [
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2026-07-28',
                capabilities: {},
                clientInfo: { name: 'test', version: '0' },
              },
            }),
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
          ]
            .map(line => line + '\n')
            .join(''),
        )
        proc.stdin.flush()

        let response: { error?: unknown; result?: { tools?: unknown[] } } | undefined
        while (!response) {
          const msg = await nextMessage()
          if (msg.id === 2) response = msg
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

  test(
    'a tools/call with an unknown argument is rejected with an input validation error',
    async () => {
      const proc = Bun.spawn(['bun', 'src/stdio.ts'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      })

      try {
        const nextMessage = lineReader(proc)

        // the original F1 incident: search_patches with a nonexistent "target"
        proc.stdin.write(
          [
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2026-07-28',
                capabilities: {},
                clientInfo: { name: 'test', version: '0' },
              },
            }),
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'search_patches',
                arguments: { target: 'StorytellerDef' },
              },
            }),
          ]
            .map(line => line + '\n')
            .join(''),
        )
        proc.stdin.flush()

        let response:
          | { error?: unknown; result?: { isError?: unknown; content?: Array<{ text?: unknown }> } }
          | undefined
        while (!response) {
          const msg = await nextMessage()
          if (msg.id === 2) response = msg
        }

        expect(response.error).toBeUndefined()
        expect(response.result!.isError).toBe(true)
        expect(response.result!.content![0]!.text).toContain('Input validation error')
        expect(response.result!.content![0]!.text).toContain('search_patches')
      } finally {
        proc.kill()
      }
    },
    60_000,
  )
})

/** Reads newline-delimited JSON-RPC messages from the server's stdout. */
function lineReader(proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>) {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  return async function nextMessage(): Promise<any> {
    for (;;) {
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) return JSON.parse(line)
      }
      const { done, value } = await reader.read()
      if (done) throw new Error('server exited before answering')
      buffer += decoder.decode(value, { stream: true })
    }
  }
}
