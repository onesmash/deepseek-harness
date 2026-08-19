/** ACP-owned stdio MCP fixture with observable discovery, calls, and shutdown. */

import { appendFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const stateFile = process.argv[2]

/** Record the externally observable fixture lifecycle when a state file is supplied. */
function record(event: string): void {
  if (stateFile !== undefined) appendFileSync(stateFile, `${event}\n`)
}

const server = new McpServer(
  { name: 'acp-mcp-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.registerTool('add', {
  description: 'Adds two numbers.',
  inputSchema: { a: z.number(), b: z.number() },
}, async ({ a, b }) => {
  const result = a + b
  record(`add:${result}`)
  return { content: [{ type: 'text', text: String(result) }] }
})

process.once('exit', () => { record('stopped') })
record('started')
await server.connect(new StdioServerTransport())
