/** Real ACP bridge coverage for dynamic MCP discovery, execution, isolation, and rollback. */

import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

const fixtureServerPath = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

function toolCallResponse(name: string, args: Record<string, unknown>): StreamChunk[] {
  const callId = CallId('dynamic-mcp-call')
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function initialize(harness: BridgeHarness): Promise<void> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
}

async function state(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

describe('ACP dynamic MCP', () => {
  let harness: BridgeHarness | undefined
  let tempDir: string | undefined
  let httpServer: Server | undefined
  const httpFixtureCleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    await harness?.dispose()
    await Promise.all(httpFixtureCleanups.splice(0).map(cleanup => cleanup()))
    if (httpServer !== undefined) {
      const server = httpServer
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    harness = undefined
    httpServer = undefined
    tempDir = undefined
  })

  it('discovers a stdio server, calls its tool through AgentLoop, and keeps configuration out of the model and session log', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-acp-mcp-'))
    const fixtureState = join(tempDir, 'stdio-state.log')
    const commandSecret = 'stdio-command-secret'
    const commandPath = join(tempDir, commandSecret)
    const argumentSecret = 'stdio-argument-secret'
    const envSecret = 'stdio-env-secret'
    await symlink(process.execPath, commandPath)
    harness = await makeBridgeHarness({
      script: [toolCallResponse('mcp__fixture__add', { a: 2, b: 3 }), textResponse('MCP_RESULT_OK: 5')],
    })
    await initialize(harness)

    const { sessionId } = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{
        name: 'fixture', command: commandPath,
        args: [fixtureServerPath, fixtureState, argumentSecret],
        env: [{ name: 'MCP_TEST_SECRET', value: envSecret }],
      }],
    })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'calculate' }] })

    expect(harness.adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('mcp__fixture__add')
    expect(harness.adapter.requests[1]?.messages.at(-1)?.content).toEqual([{
      type: 'tool-result', toolCallId: 'dynamic-mcp-call', isError: false,
      content: [{ type: 'text', text: '5' }],
    }])
    await vi.waitFor(async () => { expect(await state(fixtureState)).toContain('add:5') })
    const sessionLog = JSON.stringify(harness.ctx.agents.get(SessionId(sessionId))?.session.events)
    for (const secret of [commandSecret, argumentSecret, envSecret]) {
      expect(JSON.stringify(harness.adapter.requests)).not.toContain(secret)
      expect(sessionLog).not.toContain(secret)
    }
  }, 30_000)

  it('isolates same-named servers and rolls back the first server when later discovery fails', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-acp-mcp-'))
    const firstState = join(tempDir, 'first-state.log')
    const rollbackState = join(tempDir, 'rollback-state.log')
    harness = await makeBridgeHarness({ script: [textResponse('B remains usable')] })
    await initialize(harness)

    const a = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'fixture', command: process.execPath, args: [fixtureServerPath, firstState], env: [] }],
    })
    const b = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'fixture', command: process.execPath, args: [fixtureServerPath], env: [] }],
    })
    const agentA = harness.ctx.agents.get(SessionId(a.sessionId))!
    const agentB = harness.ctx.agents.get(SessionId(b.sessionId))!
    expect(harness.ctx.tools.get('mcp__fixture__add', agentA)).toBeDefined()
    expect(harness.ctx.tools.get('mcp__fixture__add', agentB)).toBeDefined()

    // The ACP surface intentionally has no session/close method yet. Dispose
    // the concrete Agent scope to exercise the same MCP cleanup boundary that
    // AgentHandle.dispose() uses, then prove the sibling session is unaffected.
    await (agentA as typeof agentA & { scope: { dispose(): Promise<void> } }).scope.dispose()
    expect(harness.ctx.tools.get('mcp__fixture__add', agentA)).toBeUndefined()
    expect(harness.ctx.tools.get('mcp__fixture__add', agentB)).toBeDefined()
    await expect(harness.client.prompt({ sessionId: b.sessionId, prompt: [{ type: 'text', text: 'still available' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })

    await expect(harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [
        { name: 'first', command: process.execPath, args: [fixtureServerPath, rollbackState], env: [] },
        { name: 'second', command: 'dynamic-mcp-missing-command', args: [], env: [] },
      ],
    })).rejects.toMatchObject({ code: -32603, message: 'Internal error: MCP server startup failed' })
    await vi.waitFor(async () => {
      const rollbackEvents = (await state(rollbackState)).trim().split('\n')
      expect(rollbackEvents).toEqual(['started', 'stopped'])
    })
    expect(harness.ctx.tools.get('mcp__first__add')).toBeUndefined()
    expect(harness.ctx.agents.list()).toEqual([agentA, agentB])

  }, 30_000)

  it('maps loopback Streamable HTTP headers through discovery and AgentLoop tool calls', async () => {
    const headers: string[] = []
    const httpErrors: unknown[] = []
    const urlPathSecret = 'http-url-secret'
    httpServer = createServer((request, response) => {
      handleHttpMcp(request, response, headers, httpFixtureCleanups).catch((error: unknown) => {
        httpErrors.push(error)
        response.writeHead(500).end()
      })
    })
    await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    harness = await makeBridgeHarness({
      script: [toolCallResponse('mcp__http_fixture__shout', { message: 'quiet' }), textResponse('HTTP_RESULT_OK: QUIET')],
    })
    await initialize(harness)
    const { sessionId } = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{
        type: 'http', name: 'http_fixture', url: `http://127.0.0.1:${address.port}/${urlPathSecret}/mcp`,
        headers: [{ name: 'Authorization', value: 'Bearer http-header-secret' }],
      }],
    }).catch((error: unknown) => {
      throw new Error(`${String(error)}; HTTP fixture: ${httpErrors.map(String).join(' | ')}`)
    })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'shout' }] })

    expect(harness.adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('mcp__http_fixture__shout')
    expect(headers).toContain('Bearer http-header-secret')
    expect(JSON.stringify(harness.adapter.requests)).not.toContain('http-header-secret')
    expect(JSON.stringify(harness.ctx.agents.get(SessionId(sessionId))?.session.events)).not.toContain('http-header-secret')
    expect(JSON.stringify(harness.adapter.requests)).not.toContain(urlPathSecret)
    expect(JSON.stringify(harness.ctx.agents.get(SessionId(sessionId))?.session.events)).not.toContain(urlPathSecret)
  }, 30_000)
})

async function handleHttpMcp(
  request: IncomingMessage,
  response: ServerResponse,
  headers: string[],
  cleanups: Array<() => Promise<void>>,
): Promise<void> {
  headers.push(request.headers.authorization ?? '')
  const server = new McpServer({ name: 'acp-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('shout', {
    description: 'Upper-cases a message.',
    inputSchema: { message: z.string() },
  }, async ({ message }) => ({ content: [{ type: 'text', text: message.toUpperCase() }] }))
  const transport = new StreamableHTTPServerTransport({})
  cleanups.push(async () => {
    await Promise.allSettled([
      Promise.resolve().then(() => transport.close()),
      Promise.resolve().then(() => server.close()),
    ])
  })
  await server.connect(transport as Transport)
  await transport.handleRequest(request, response)
}
