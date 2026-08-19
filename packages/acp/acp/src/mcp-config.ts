/**
 * Pure preflight mapping from ACP MCP declarations to harness MCP client config.
 * @module @deepseek-ai/dsh-acp/mcp-config
 */

import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import type * as dshMcpClient from '@deepseek-ai/dsh-mcp-client'

const MAX_SERVERS = 16
const MAX_SERVER_NAME_CODE_POINTS = 256
const MAX_COMMAND_CODE_UNITS = 4096
const MAX_ARGS = 128
const MAX_ARGUMENT_CODE_UNITS = 4096
const MAX_ENVIRONMENT_ENTRIES = 64
const MAX_HEADER_ENTRIES = 64
const MAX_ENTRY_NAME_CODE_POINTS = 256
const MAX_ENTRY_VALUE_CODE_UNITS = 4096
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
const NORMALIZED_SERVER_NAME_MAX_LENGTH = 32
const SHORT_HASH_LENGTH = 8
const PRINTABLE_ASCII_NAME_PATTERN = /^[\x20-\x7e]+$/
const ASCII_TRIM_PATTERN = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** One validated ACP server paired with its original ACP display name. */
export interface MappedMcpServer {
  /** Server name supplied by ACP. */
  sourceName: string
  /** Validated configuration for one harness MCP client instance. */
  config: dshMcpClient.Config
}

/** Error raised when ACP MCP preflight rejects a server declaration. */
export class InvalidMcpServerConfigError extends Error {
  /**
   * Create a validation error that excludes raw configuration values.
   * @param field - safe location of the rejected field.
   * @param sourceName - safe normalized source server name.
   * @param reason - fixed rejection category.
   */
  constructor(field: string, sourceName: string, reason = 'invalid') {
    super(`ACP MCP server ${sourceName}: ${reason} ${field}`)
    this.name = 'InvalidMcpServerConfigError'
  }
}

/** Return the number of Unicode code points in a string. */
function codePointLength(value: string): number {
  return Array.from(value).length
}

/** Whether a string contains bytes unsafe in configuration values or error output. */
function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value)
}

/** Trim only ASCII whitespace from an environment variable or HTTP header name. */
function trimAscii(value: string): string {
  return value.replace(ASCII_TRIM_PATTERN, '')
}

/** Return a safe identifier for error output without preserving raw config values. */
function sourceNameForError(name: string): string {
  if (name.length === 0) return 'unnamed'
  return normalizeServerName(name)
}

/** Throw a validation error for one server field. */
function invalid(field: string, sourceName: string, reason?: string): never {
  throw new InvalidMcpServerConfigError(field, sourceName, reason)
}

/** Validate the session directory before assigning it to a stdio child process. */
function validateCwd(cwd: string): string {
  if (cwd.length === 0 || hasControlCharacter(cwd) || !isAbsolute(cwd)) {
    return invalid('session.cwd', 'session')
  }
  return normalize(cwd)
}

/** Validate a server name before it becomes a public MCP namespace. */
function validateServerName(name: string, sourceName: string, field: string): void {
  if (name.trim().length === 0 || hasControlCharacter(name) || codePointLength(name) > MAX_SERVER_NAME_CODE_POINTS) {
    invalid(`${field}.name`, sourceName)
  }
}

/** Validate a scalar command, argument, environment value, or header value. */
function validateValue(value: string, maximumCodeUnits: number, field: string, sourceName: string): void {
  if (hasControlCharacter(value) || value.length > maximumCodeUnits) invalid(field, sourceName)
}

/** Validate and map named values into an ordinary record. */
function mapNamedValues(
  entries: readonly { name: string; value: string }[],
  maximumEntries: number,
  field: string,
  sourceName: string,
): Record<string, string> {
  if (entries.length > maximumEntries) invalid(field, sourceName)

  const result: Record<string, string> = {}
  const names = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const entryField = `${field}[${index}]`
    const name = trimAscii(entry.name)
    const comparableName = name.toLowerCase()
    if (
      name.length === 0
      || hasControlCharacter(name)
      || codePointLength(name) > MAX_ENTRY_NAME_CODE_POINTS
      || !PRINTABLE_ASCII_NAME_PATTERN.test(name)
      || name.includes(':')
      || name.includes('=')
      || PROTOTYPE_POLLUTION_KEYS.has(comparableName)
      || names.has(comparableName)
    ) {
      invalid(`${entryField}.name`, sourceName)
    }
    validateValue(entry.value, MAX_ENTRY_VALUE_CODE_UNITS, `${entryField}.value`, sourceName)
    names.add(comparableName)
    result[name] = entry.value
  }
  return result
}

/** Whether an HTTP URL host is a local loopback endpoint. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/** Validate an ACP HTTP endpoint and preserve its original serialized URL. */
function validateHttpUrl(value: string, field: string, sourceName: string): string {
  if (hasControlCharacter(value)) invalid(field, sourceName)

  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid(field, sourceName)
  }

  if (
    url.protocol !== 'https:'
    && (url.protocol !== 'http:' || !isLoopbackHost(url.hostname))
  ) {
    invalid(field, sourceName)
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) invalid(field, sourceName)
  return value
}

/** Map one ACP stdio declaration without joining command arguments into a shell string. */
function mapStdioServer(
  server: Extract<McpServer, { command: string }>,
  sourceName: string,
  serverName: string,
  field: string,
  cwd: string,
): MappedMcpServer {
  validateValue(server.command, MAX_COMMAND_CODE_UNITS, `${field}.command`, sourceName)
  if (server.command.length === 0) invalid(`${field}.command`, sourceName)
  if (server.args.length > MAX_ARGS) invalid(`${field}.args`, sourceName)
  for (const [index, argument] of server.args.entries()) {
    validateValue(argument, MAX_ARGUMENT_CODE_UNITS, `${field}.args[${index}]`, sourceName)
  }

  return {
    sourceName: server.name,
    config: {
      transport: 'stdio',
      serverName,
      command: server.command,
      args: [...server.args],
      env: mapNamedValues(server.env, MAX_ENVIRONMENT_ENTRIES, `${field}.env`, sourceName),
      cwd,
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: true,
    },
  }
}

/** Map one ACP HTTP declaration to the harness Streamable HTTP transport. */
function mapHttpServer(
  server: Extract<McpServer, { type: 'http' }>,
  sourceName: string,
  serverName: string,
  field: string,
): MappedMcpServer {
  return {
    sourceName: server.name,
    config: {
      transport: 'streamable-http',
      serverName,
      url: validateHttpUrl(server.url, `${field}.url`, sourceName),
      headers: mapNamedValues(server.headers, MAX_HEADER_ENTRIES, `${field}.headers`, sourceName),
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: true,
    },
  }
}

/**
 * Convert an ACP server name into the MCP client's bounded tool namespace.
 * @param name - ACP-provided server display name.
 * @returns an identifier accepted by the harness MCP client.
 */
export function normalizeServerName(name: string): string {
  const replaced = Array.from(name, character => /[A-Za-z0-9_-]/.test(character) ? character : '_').join('')
  if (replaced === name && replaced.length <= NORMALIZED_SERVER_NAME_MAX_LENGTH) return replaced

  const prefixLength = NORMALIZED_SERVER_NAME_MAX_LENGTH - SHORT_HASH_LENGTH - 1
  const prefix = replaced.replace(/^_+|_+$/g, '').slice(0, prefixLength) || 'server'
  const hash = createHash('sha256').update(name).digest('hex').slice(0, SHORT_HASH_LENGTH)
  return `${prefix}_${hash}`
}

/**
 * Validate and map ACP MCP declarations before any plugin or transport is created.
 * @param servers - ACP-provided MCP server declarations.
 * @param cwd - absolute session directory used by stdio MCP servers.
 * @returns validated harness MCP client configurations in ACP order.
 * @throws {InvalidMcpServerConfigError} when a declaration cannot be mapped safely.
 */
export function mapMcpServers(servers: readonly McpServer[], cwd: string): MappedMcpServer[] {
  const validatedCwd = validateCwd(cwd)
  if (servers.length > MAX_SERVERS) invalid('servers', 'session')

  const mapped: MappedMcpServer[] = []
  const normalizedNames = new Set<string>()
  for (const [index, server] of servers.entries()) {
    const field = `servers[${index}]`
    const sourceName = sourceNameForError(server.name)
    validateServerName(server.name, sourceName, field)
    const serverName = normalizeServerName(server.name)
    if (normalizedNames.has(serverName)) invalid(`${field}.name`, sourceName, 'duplicate')
    normalizedNames.add(serverName)

    if ('command' in server) {
      mapped.push(mapStdioServer(server, sourceName, serverName, field, validatedCwd))
    } else if (server.type === 'http') {
      mapped.push(mapHttpServer(server, sourceName, serverName, field))
    } else {
      invalid(`${field}.type`, sourceName, 'unsupported')
    }
  }
  return mapped
}
