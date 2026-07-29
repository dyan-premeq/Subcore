import { serve } from 'bun'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createServer } from './server'

const mcpHandler = createMcpHandler(createServer)

const httpServer = serve({
  routes: {
    '/health': Response.json({ status: 'ok' }),
    '/mcp': (req, bunServer) => {
      // streaming MCP responses can exceed the default request idle timeout.
      bunServer.timeout(req, 0)

      return mcpHandler.fetch(req)
    },
    '/*': new Response('Not Found', { status: 404 }),
  },
})

console.error(
  '\x1b[32m%s\x1b[0m',
  `RimSage MCP HTTP server listening on ${httpServer.url}`,
)
