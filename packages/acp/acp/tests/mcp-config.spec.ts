import { createHash } from 'node:crypto'
import type { McpServer } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  InvalidMcpServerConfigError,
  mapMcpServers,
  normalizeServerName,
} from '../src/mcp-config.ts'

type StdioServer = Extract<McpServer, { command: string }>
type HttpServer = Extract<McpServer, { type: 'http' }>

const makeStdio = (overrides: Partial<StdioServer> = {}): StdioServer => ({
  name: 'fixture',
  command: process.execPath,
  args: ['fixture.mjs'],
  env: [],
  ...overrides,
})

const makeHttp = (overrides: Partial<HttpServer> = {}): HttpServer => ({
  type: 'http',
  name: 'remote',
  url: 'https://example.test/mcp',
  headers: [],
  ...overrides,
})

const envEntry = (name: string, value = 'value'): StdioServer['env'][number] => ({ name, value })
const headerEntry = (name: string, value = 'value'): HttpServer['headers'][number] => ({ name, value })

const expectInvalid = (run: () => unknown): void => {
  expect(run).toThrow(InvalidMcpServerConfigError)
}

describe('ACP MCP preflight mapper', () => {
  it('maps ACP stdio without shell interpolation', () => {
    const command = `${process.execPath} with spaces`
    const args = ['fixture.mjs', 'two words', '$(touch should-not-run)']

    expect(mapMcpServers([makeStdio({ command, args, env: [envEntry(' FIXTURE_MODE ', 'test')] })], '/tmp/work'))
      .toEqual([{
        sourceName: 'fixture',
        config: {
          transport: 'stdio',
          serverName: 'fixture',
          command,
          args,
          env: { FIXTURE_MODE: 'test' },
          cwd: '/tmp/work',
          toolCallTimeoutMs: 60_000,
          failOnStartupError: true,
        },
      }])
  })

  it('maps ACP HTTP to streamable HTTP and preserves headers', () => {
    expect(mapMcpServers([makeHttp({ headers: [headerEntry(' Authorization ', 'Bearer token')] })], '/tmp/work'))
      .toEqual([{
        sourceName: 'remote',
        config: {
          transport: 'streamable-http',
          serverName: 'remote',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer token' },
          toolCallTimeoutMs: 60_000,
          failOnStartupError: true,
        },
      }])
  })

  it('maps an empty server list to an empty list', () => {
    expect(mapMcpServers([], '/tmp/work')).toEqual([])
  })

  it.each([
    ['sse', { type: 'sse', name: 'remote', url: 'https://example.test', headers: [] }],
    ['acp', { type: 'acp', name: 'remote', id: 'server-id' }],
  ] as const)('rejects unsupported %s transport before mapping', (_transport, server) => {
    expect(() => mapMcpServers([server as McpServer], '/tmp/work'))
      .toThrow(/remote.*unsupported/i)
  })

  it('rejects a relative session cwd', () => {
    expectInvalid(() => mapMcpServers([makeStdio()], 'relative/work'))
  })

  it.each([
    'relative/path',
    'ftp://example.test/mcp',
    'http://example.test/mcp',
    'http://localhost.example.test/mcp',
  ])('rejects an invalid or non-loopback URL: %s', (url) => {
    expectInvalid(() => mapMcpServers([makeHttp({ url })], '/tmp/work'))
  })

  it.each([
    'https://user:password@example.test/mcp',
    'https://example.test/mcp#fragment',
  ])('rejects URL credentials and fragments: %s', (url) => {
    expectInvalid(() => mapMcpServers([makeHttp({ url })], '/tmp/work'))
  })

  it('allows HTTPS and loopback HTTP URLs', () => {
    expect(mapMcpServers([
      makeHttp({ name: 'https-server', url: 'https://example.test/mcp' }),
      makeHttp({ name: 'localhost-server', url: 'http://localhost:3000/mcp' }),
      makeHttp({ name: 'ipv4-server', url: 'http://127.0.0.1:3000/mcp' }),
      makeHttp({ name: 'ipv6-server', url: 'http://[::1]:3000/mcp' }),
    ], '/tmp/work')).toHaveLength(4)
  })

  it.each([
    '',
    '   ',
    '\u00a0',
  ])('rejects an empty or whitespace-only server name: %j', (name) => {
    expectInvalid(() => mapMcpServers([makeStdio({ name })], '/tmp/work'))
  })

  it('counts Unicode code points for the server-name limit', () => {
    expectInvalid(() => mapMcpServers([makeStdio({ name: '😀'.repeat(257) })], '/tmp/work'))
    expect(mapMcpServers([makeStdio({ name: '😀'.repeat(256) })], '/tmp/work')[0]?.config.serverName)
      .toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })

  it('normalizes invalid server-name characters with a deterministic short hash', () => {
    const name = 'remote service/v1'
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)

    expect(normalizeServerName(name)).toBe(`remote_service_v1_${hash}`)
    expect(normalizeServerName('fixture')).toBe('fixture')
    expect(normalizeServerName('x'.repeat(33))).toBe(
      `xxxxxxxxxxxxxxxxxxxxxxx_${createHash('sha256').update('x'.repeat(33)).digest('hex').slice(0, 8)}`,
    )
  })

  it('trims replacement underscores before appending the short hash', () => {
    const name = '@remote@'
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)

    expect(normalizeServerName(name)).toBe(`remote_${hash}`)
  })

  it('uses the server fallback when underscore trimming removes the whole prefix', () => {
    expect(normalizeServerName('@')).toBe('server_c3641f85')
  })

  it('rejects duplicate normalized server namespaces', () => {
    expectInvalid(() => mapMcpServers([makeStdio(), makeStdio()], '/tmp/work'))
  })

  it('rejects a final namespace that collides with a short-hash name', () => {
    const sourceName = 'remote service/v1'

    expectInvalid(() => mapMcpServers([
      makeStdio({ name: sourceName }),
      makeStdio({ name: normalizeServerName(sourceName) }),
    ], '/tmp/work'))
  })

  it('rejects duplicate environment names case-insensitively after ASCII trim', () => {
    expectInvalid(() => mapMcpServers([makeStdio({
      env: [envEntry(' FOO ', 'first'), envEntry('foo', 'second')],
    })], '/tmp/work'))
  })

  it('rejects duplicate header names case-insensitively after ASCII trim', () => {
    expectInvalid(() => mapMcpServers([makeHttp({
      headers: [headerEntry(' X-Token ', 'first'), headerEntry('x-token', 'second')],
    })], '/tmp/work'))
  })

  it.each(['', '  ', 'bad:name', 'bad=name', 'bad\nname', 'é'])('rejects unsafe environment names: %j', (name) => {
    expectInvalid(() => mapMcpServers([makeStdio({ env: [envEntry(name)] })], '/tmp/work'))
  })

  it.each(['', '  ', 'bad:name', 'bad=value', 'bad\rname', 'é'])('rejects unsafe header names: %j', (name) => {
    expectInvalid(() => mapMcpServers([makeHttp({ headers: [headerEntry(name)] })], '/tmp/work'))
  })

  it('accepts non-empty printable ASCII environment and header names after ASCII trim', () => {
    const stdioConfig = mapMcpServers([makeStdio({ env: [envEntry(' ENV-NAME!?$ ', 'value')] })], '/tmp/work')[0]?.config
    expect(stdioConfig?.transport).toBe('stdio')
    if (stdioConfig?.transport !== 'stdio') throw new Error('expected stdio configuration')
    expect(stdioConfig.env)
      .toEqual({ 'ENV-NAME!?$': 'value' })
    const httpConfig = mapMcpServers([makeHttp({ headers: [headerEntry(' Header Name!?$ ', 'value')] })], '/tmp/work')[0]?.config
    expect(httpConfig?.transport).toBe('streamable-http')
    if (httpConfig?.transport !== 'streamable-http') throw new Error('expected HTTP configuration')
    expect(httpConfig.headers)
      .toEqual({ 'Header Name!?$': 'value' })
  })

  it.each(['__proto__', '__PROTO__', 'constructor', 'prototype'])('rejects prototype-pollution environment names case-insensitively: %s', (name) => {
    expectInvalid(() => mapMcpServers([makeStdio({ env: [envEntry(name)] })], '/tmp/work'))
  })

  it.each(['__proto__', '__PROTO__', 'constructor', 'prototype'])('rejects prototype-pollution header names case-insensitively: %s', (name) => {
    expectInvalid(() => mapMcpServers([makeHttp({ headers: [headerEntry(name)] })], '/tmp/work'))
  })

  it('enforces the server count cap', () => {
    expectInvalid(() => mapMcpServers(Array.from({ length: 17 }, (_, index) => makeStdio({ name: `server-${index}` })), '/tmp/work'))
    expect(mapMcpServers(Array.from({ length: 16 }, (_, index) => makeStdio({ name: `server-${index}` })), '/tmp/work'))
      .toHaveLength(16)
  })

  it('enforces command, argument-count, and argument-length caps', () => {
    expect(mapMcpServers([makeStdio({
      command: 'c'.repeat(4096),
      args: ['a'.repeat(4096)],
    })], '/tmp/work')).toHaveLength(1)

    expectInvalid(() => mapMcpServers([makeStdio({ command: 'c'.repeat(4097) })], '/tmp/work'))
    expectInvalid(() => mapMcpServers([makeStdio({ args: ['a'.repeat(4097)] })], '/tmp/work'))
    expectInvalid(() => mapMcpServers([makeStdio({ args: Array.from({ length: 129 }, () => 'arg') })], '/tmp/work'))
  })

  it('counts command and argument limits in UTF-16 code units', () => {
    const atLimit = '😀'.repeat(2048)
    const overLimit = '😀'.repeat(2049)

    expect(mapMcpServers([makeStdio({ command: atLimit, args: [atLimit] })], '/tmp/work')).toHaveLength(1)
    expectInvalid(() => mapMcpServers([makeStdio({ command: overLimit })], '/tmp/work'))
    expectInvalid(() => mapMcpServers([makeStdio({ args: [overLimit] })], '/tmp/work'))
  })

  it('enforces environment count, name-length, and value-length caps', () => {
    expect(mapMcpServers([makeStdio({ env: Array.from({ length: 64 }, (_, index) => envEntry(`ENV_${index}`)) })], '/tmp/work'))
      .toHaveLength(1)
    expect(mapMcpServers([makeStdio({ env: [envEntry('N'.repeat(256), 'v'.repeat(4096))] })], '/tmp/work'))
      .toHaveLength(1)

    expectInvalid(() => mapMcpServers([makeStdio({ env: Array.from({ length: 65 }, (_, index) => envEntry(`ENV_${index}`)) })], '/tmp/work'))
    expectInvalid(() => mapMcpServers([makeStdio({ env: [envEntry('N'.repeat(257))] })], '/tmp/work'))
    expectInvalid(() => mapMcpServers([makeStdio({ env: [envEntry('NAME', 'v'.repeat(4097))] })], '/tmp/work'))
  })

  it('counts environment values in UTF-16 code units', () => {
    const atLimit = '😀'.repeat(2048)
    const overLimit = '😀'.repeat(2049)

    expect(mapMcpServers([makeStdio({ env: [envEntry('NAME', atLimit)] })], '/tmp/work')).toHaveLength(1)
    expectInvalid(() => mapMcpServers([makeStdio({ env: [envEntry('NAME', overLimit)] })], '/tmp/work'))
  })

  it('enforces header count, name-length, and value-length caps', () => {
    expect(mapMcpServers([makeHttp({ headers: Array.from({ length: 64 }, (_, index) => headerEntry(`X-Header-${index}`)) })], '/tmp/work'))
      .toHaveLength(1)
    expect(mapMcpServers([makeHttp({ headers: [headerEntry('H'.repeat(256), 'v'.repeat(4096))] })], '/tmp/work'))
      .toHaveLength(1)

    expectInvalid(() => mapMcpServers([makeHttp({ headers: Array.from({ length: 65 }, (_, index) => headerEntry(`X-Header-${index}`)) })], '/tmp/work'))
    expectInvalid(() => mapMcpServers([makeHttp({ headers: [headerEntry('H'.repeat(257))] })], '/tmp/work'))
    expectInvalid(() => mapMcpServers([makeHttp({ headers: [headerEntry('X-Header', 'v'.repeat(4097))] })], '/tmp/work'))
  })

  it('counts header values in UTF-16 code units', () => {
    const atLimit = '😀'.repeat(2048)
    const overLimit = '😀'.repeat(2049)

    expect(mapMcpServers([makeHttp({ headers: [headerEntry('X-Header', atLimit)] })], '/tmp/work')).toHaveLength(1)
    expectInvalid(() => mapMcpServers([makeHttp({ headers: [headerEntry('X-Header', overLimit)] })], '/tmp/work'))
  })

  it('does not include raw configuration values in validation errors', () => {
    const secretCommand = '/private/command?token=command-secret'
    const secretArg = 'argument-secret'
    const secretEnvValue = 'env-secret'
    const error = (() => {
      try {
        mapMcpServers([makeStdio({
          command: secretCommand,
          args: [secretArg],
          env: [envEntry('SECRET', secretEnvValue), envEntry('secret', 'other')],
        })], '/tmp/work')
      } catch (caught: unknown) {
        return caught
      }
      throw new Error('expected mapper to reject the duplicate environment name')
    })()

    expect(error).toBeInstanceOf(InvalidMcpServerConfigError)
    expect((error as Error).message).not.toContain(secretCommand)
    expect((error as Error).message).not.toContain(secretArg)
    expect((error as Error).message).not.toContain(secretEnvValue)
  })

  it.each([
    ['command', 'command-secret', () => mapMcpServers([makeStdio({ command: `command-secret${String.fromCharCode(0)}` })], '/tmp/work')],
    ['argument', 'argument-secret', () => mapMcpServers([makeStdio({ args: [`argument-secret${String.fromCharCode(0)}`] })], '/tmp/work')],
    ['header', 'header-secret', () => mapMcpServers([makeHttp({ headers: [headerEntry('header-secret:name')] })], '/tmp/work')],
    ['URL', 'url-secret', () => mapMcpServers([makeHttp({ url: 'https://url-secret@example.test/mcp' })], '/tmp/work')],
    ['value', 'value-secret', () => mapMcpServers([makeStdio({ env: [envEntry('NAME', `value-secret${String.fromCharCode(0)}`)] })], '/tmp/work')],
  ])('redacts raw %s data from validation errors', (_field, secret, run) => {
    let error: unknown
    try {
      run()
    } catch (caught: unknown) {
      error = caught
    }

    expect(error).toBeInstanceOf(InvalidMcpServerConfigError)
    expect((error as Error).message).not.toContain(secret)
  })
})
