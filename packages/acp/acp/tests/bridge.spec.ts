import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, type McpServer } from '@agentclientprotocol/sdk'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

const fixtureServerPath = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

describe('automation-only ACP bridge', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('advertises fresh text sessions and HTTP MCP', async () => {
    harness = await makeBridgeHarness()
    const response = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { _meta: { terminal_output: true } },
    })

    expect(response).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: true },
      },
      authMethods: [],
    })
  })

  it('advertises image prompts only with an exact capable route and attachment store', async () => {
    harness = await makeBridgeHarness({ imageCapable: true })
    const capable = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(capable.agentCapabilities?.promptCapabilities?.image).toBe(true)
    await harness.dispose()

    harness = await makeBridgeHarness({ imageCapable: true, attachments: false })
    const noStore = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(noStore.agentCapabilities?.promptCapabilities?.image).toBe(false)
  })

  it('negotiates an unsupported version and accepts the required no-op authentication call', async () => {
    harness = await makeBridgeHarness()
    const response = await harness.client.initialize({ protocolVersion: 0, clientCapabilities: {} })
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
    await expect(harness.client.authenticate({ methodId: 'unused' })).resolves.toEqual({})
  })

  it('creates a session, emits one committed answer, and settles the prompt', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('hello there')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'say hello' }],
    })

    expect(result.stopReason).toBe('end_turn')
    await vi.waitFor(() => { expect(harness!.updates).toHaveLength(1) })
    expect(harness.updates).toEqual([{
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello there' },
    }])
    expect(harness.ctx.agents.get(SessionId(sessionId))?.session.header.cwd).toBe(process.cwd())
    expect(harness.adapter.requests[0]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'say hello' }])
  })

  it('leaves absent agent targets for request listeners to supply', async () => {
    harness = await makeBridgeHarness({ config: { provider: undefined, model: undefined } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    expect(harness.ctx.agents.get(SessionId(sessionId))?.options).toEqual({})
  })

  it('concatenates text blocks without exposing protocol framing to the model', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'first' },
        { type: 'text', text: ' second' },
      ],
    })

    expect(harness.adapter.requests[0]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'first second' }])
  })

  it('admits mixed text/image prompts in wire order and logs references only', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const resolve = vi.spyOn(harness.ctx.llm, 'resolveModelInfo')
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'before' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
        { type: 'text', text: 'between' },
        { type: 'image', data: 'Ag==', mimeType: 'image/jpeg' },
        { type: 'text', text: 'after' },
      ],
    })

    expect(resolve).toHaveBeenCalledWith('mock', 'mock', expect.any(AbortSignal))
    expect(harness.attachments?.saved.map(input => [...input.data])).toEqual([[1], [2]])
    const requestContent = harness.adapter.requests[0]?.messages.at(-1)?.content
    expect(requestContent?.map(block => block.type)).toEqual(['text', 'image', 'text', 'image', 'text'])
    expect(requestContent?.[0]).toEqual({ type: 'text', text: 'before' })
    expect(requestContent?.[2]).toEqual({ type: 'text', text: 'between' })
    expect(requestContent?.[4]).toEqual({ type: 'text', text: 'after' })
    const firstImage = requestContent?.[1]
    const secondImage = requestContent?.[3]
    if (firstImage?.type !== 'image' || secondImage?.type !== 'image') throw new Error('expected ordered image blocks')
    expect(firstImage.attachment.mediaType).toBe('image/png')
    expect(firstImage.attachment.bytes).toBe(1)
    expect(secondImage.attachment.mediaType).toBe('image/jpeg')
    expect(secondImage.attachment.bytes).toBe(1)
    const agent = harness.ctx.agents.get(SessionId(sessionId))
    expect(JSON.stringify(agent?.session.events)).not.toContain('AQ==')
  })

  it('rejects a malformed image batch atomically and frees the prompt slot', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [textResponse('recovered')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
        { type: 'image', data: 'not base64', mimeType: 'image/png' },
      ],
    })).rejects.toThrow(/canonical base64/)
    expect(harness.attachments?.saved).toEqual([])

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'retry' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('reports durable image write failures as internal prompt failures', async () => {
    harness = await makeBridgeHarness({ imageCapable: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    vi.spyOn(harness.attachments!, 'saveImages').mockRejectedValueOnce(
      new AttachmentError('disk failed', 'ATTACHMENT_WRITE_FAILED'),
    )

    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).rejects.toThrow(/unable to persist the prompt image batch/)
  })

  it('renders the deployment persona for an ACP-created agent', async () => {
    harness = await makeBridgeHarness({ persona: 'Automation persona for {{model}} in {{cwd}}.', script: [textResponse('ok')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(harness.adapter.requests[0]?.system).toContain(`Automation persona for mock in ${process.cwd()}.`)
  })

  it('creates a session after stdio MCP tool discovery', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    const { sessionId } = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{
        name: 'fixture',
        command: process.execPath,
        args: [fixtureServerPath],
        env: [],
      }],
    })

    const agent = harness.ctx.agents.get(SessionId(sessionId))
    expect(harness.ctx.tools.get('mcp__fixture__add', agent)).toBeDefined()
  }, 30_000)

  it('requires one absolute workspace and no additional directories', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(harness.client.newSession({ cwd: 'relative', mcpServers: [] })).rejects.toThrow(/absolute path/)
    await expect(harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: ['/tmp/other'],
    })).rejects.toThrow(/additionalDirectories/)
    await expect(harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: [],
    })).resolves.toHaveProperty('sessionId')
  })

  const invalidMcpServerCases: Array<[string, McpServer]> = [
    ['SSE', { type: 'sse', name: 'unsupported', url: 'https://example.test/mcp', headers: [] }],
    ['ACP', { type: 'acp', name: 'unsupported', id: 'server-id' }],
    ['non-loopback HTTP', { type: 'http', name: 'unsafe-http', url: 'http://example.test/mcp', headers: [] }],
    ['duplicate environment names', {
      name: 'duplicate-env', command: 'node', args: [], env: [{ name: 'TOKEN', value: 'one' }, { name: 'token', value: 'two' }],
    }],
    ['duplicate HTTP header names', {
      type: 'http', name: 'duplicate-header', url: 'https://example.test/mcp', headers: [{ name: 'Authorization', value: 'one' }, { name: 'authorization', value: 'two' }],
    }],
  ]

  it.each(invalidMcpServerCases)('rejects %s MCP configuration as invalid params', async (_label, server) => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [server] }))
      .rejects.toMatchObject({ code: -32602 })
  })

  it('reports MCP startup failures without exposing server configuration', async () => {
    const command = 'mcp-command-secret'
    harness = await makeBridgeHarness()
    const diagnostics: string[] = []
    harness.ctx.logger.warn = (message: string) => { diagnostics.push(message) }
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    const error = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'startup', command, args: ['mcp-argument-secret'], env: [{ name: 'MCP_ENV_SECRET', value: 'mcp-value-secret' }] }],
    }).catch((reason: unknown) => reason)

    expect(error).toMatchObject({ code: -32603, message: 'Internal error: MCP server startup failed' })
    expect(String(error)).not.toContain(command)
    expect(String(error)).not.toContain('mcp-argument-secret')
    expect(String(error)).not.toContain('MCP_ENV_SECRET')
    expect(String(error)).not.toContain('mcp-value-secret')
    expect(diagnostics.some(line => line.startsWith('mcp-client(startup): connection attempt failed'))).toBe(true)
    expect(diagnostics.join('\n')).not.toContain(command)
    expect(diagnostics.join('\n')).not.toContain('mcp-argument-secret')
    expect(diagnostics.join('\n')).not.toContain('MCP_ENV_SECRET')
    expect(diagnostics.join('\n')).not.toContain('mcp-value-secret')
  })

  it('rejects empty and unadvertised image prompts before a turn starts', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '  ' }] }))
      .rejects.toThrow(/empty prompt/)
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: '', mimeType: 'image/png' }],
    })).rejects.toThrow(/inline image prompts were not advertised/)
    expect(harness.ctx.agents.get(SessionId(sessionId))?.session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  it('renders baseline resource links as textual references in the user message', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'summarize' },
        { type: 'resource_link', name: 'notes.txt', uri: 'file:///tmp/notes.txt' },
      ],
    })
    expect(harness.adapter.requests[0]?.messages.at(-1)?.content).toEqual([{
      type: 'text',
      text: 'summarize\n[resource_link name="notes.txt" uri="file:///tmp/notes.txt"]\n',
    }])
  })

  it('rejects prompts for unknown sessions and ignores unknown cancellation', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.prompt({ sessionId: 'missing', prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/unknown session/)
    await expect(harness.client.cancel({ sessionId: 'missing' })).resolves.toBeUndefined()
  })
})
