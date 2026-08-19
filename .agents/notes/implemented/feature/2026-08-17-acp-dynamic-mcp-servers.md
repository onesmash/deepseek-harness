# Agent Note: ACP dynamic MCP servers belong to the session Agent

Status: implemented

English | [中文](2026-08-17-acp-dynamic-mcp-servers.zh.md)

## Problem

An ACP caller needs to supply MCP servers for one new session without exposing those servers or their tools to other sessions. Mounting them on the root or global Context would share capabilities across Agents, create cross-session namespace conflicts, and leave cleanup outside the session owner.

## Decision

[`@deepseek-ai/dsh-acp`](../../../../packages/acp/acp/README.md) accepts stdio and `type: "http"` declarations in `session/new.mcpServers`. It performs pure preflight before any spawn, DNS lookup, socket, or plugin mount: server and field limits, normalized namespace uniqueness, duplicate named values, absolute cwd, and the URL policy are checked together. HTTPS is required except for loopback `http:` endpoints; URL credentials and fragments reject. ACP advertises only HTTP MCP capability and rejects SSE and ACP transports.

ACP maps each accepted declaration to [`@deepseek-ai/dsh-mcp-client`](../../../../packages/mcp/mcp-client/README.md) with `failOnStartupError: true`. It creates the clients inside the unpublished Agent setup, so the Agent enters the registry only after connection and initial tool discovery finish. Startup uses the MCP client's `startupTimeoutMs` default of `30000` ms. Validation failures return `Invalid params` with safe field locations; startup failures use a fixed internal error that omits request configuration and remote diagnostics.

MCP namespaces reserve `serverName` per exact scope. The same name can therefore be used by different session Agents, while a duplicate in one scope fails. A scoped generation rejects a public tool already registered at root/global scope; root/global registration after the scoped generation retains ToolRuntime's usual scoped-shadow ordering. Connection-owned teardown disposes the Agent scope and its MCP children together; ACP exposes no per-session close operation.

The detailed protocol and mapping rules live in the [ACP package README](../../../../packages/acp/acp/README.md) and [MCP client README](../../../../packages/mcp/mcp-client/README.md).

## Verification

ACP unit coverage pins supported stdio and HTTP declarations, capability advertisement, preflight rejection, safe error mapping, unpublished-Agent rollback, and scoped cleanup. The real ACP E2E starts stdio and Streamable HTTP fixture servers, verifies discovery and `tools/call`, and covers concurrent same-name sessions and startup rollback. The keyless `dynamic-mcp` snapshot replays a real stdio fixture through the assembled ACP example and pins the scoped schema, tool call, tool result, session JSONL, and protocol stdout without recording configuration secrets.

The focused verification commands are `pnpm exec vitest run packages/acp/acp/tests/mcp-config.spec.ts packages/acp/acp/tests/bridge.spec.ts packages/mcp/mcp-client/tests/apply.spec.ts packages/mcp/mcp-client/tests/reconnect.spec.ts`, `pnpm exec vitest run --config vitest.e2e.config.ts packages/acp/acp/tests/dynamic-mcp.e2e.ts`, and `pnpm exec vitest run --config vitest.snapshot.config.ts examples/acp-agent/tests/acp.snapshot.ts -t dynamic-mcp`.

## Alternatives considered

- **Root or global MCP mounting** — rejected because every ACP session would share the same registrations and lifetime, violating per-session capability isolation.
- **Mounting after publishing the Agent** — rejected because a successful `session/new` could expose an Agent without its requested tools and could not roll back the whole setup atomically.
- **Accepting SSE or ACP transports as HTTP** — rejected because the MCP client implements stdio and Streamable HTTP only; capability advertisement and validation remain exact.

## Consequences

ACP callers can attach independent MCP tool sets to concurrent sessions, including same-name servers, and failed startup leaves no published partial session. The trusted ACP host remains responsible for authorizing callers that may request local commands or network endpoints; request validation prevents unsafe protocol mappings but is not a sandbox. Per-session early release requires a future ACP protocol operation.
