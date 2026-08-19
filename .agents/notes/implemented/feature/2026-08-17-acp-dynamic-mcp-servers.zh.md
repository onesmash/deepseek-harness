# Agent Note: ACP 动态 MCP 服务器属于会话 Agent

Status: implemented

[English](2026-08-17-acp-dynamic-mcp-servers.md) | 中文

## 问题

ACP 调用方需要为一个新会话提供 MCP 服务器，而不应把这些服务器及其工具暴露给其他会话。将它们挂载到 root 或 global Context 会在 Agent 间共享能力，造成跨会话 namespace 冲突，并让清理职责脱离会话所有者。

## 决策

[`@deepseek-ai/dsh-acp`](../../../../packages/acp/acp/README.md) 在 `session/new.mcpServers` 中接受 stdio 和 `type: "http"` 声明。它会在任何 spawn、DNS 查询、socket 或插件挂载之前执行纯 preflight：统一检查服务器与字段限制、规范化 namespace 的唯一性、重复的具名值、绝对 cwd 和 URL 策略。HTTPS 是必需的，只有 loopback `http:` endpoint 例外；带 URL 凭据或 fragment 的请求会被拒绝。ACP 只公布 HTTP MCP capability，并拒绝 SSE 和 ACP 传输。

ACP 将每个接受的声明映射给 [`@deepseek-ai/dsh-mcp-client`](../../../../packages/mcp/mcp-client/README.md)，并设置 `failOnStartupError: true`。它在尚未发布的 Agent setup 中创建 client，因此只有连接和初始工具发现完成后 Agent 才会进入 registry。启动使用 MCP client 的 `startupTimeoutMs` 默认值 `30000` 毫秒。校验失败以带安全字段位置的 `Invalid params` 返回；启动失败使用固定的内部错误，不会泄漏请求配置或远端诊断。

MCP namespace 会按精确 scope 保留 `serverName`。因此，不同会话 Agent 可以使用同名服务器，而同一 scope 内的重复名称会失败。scoped generation 会拒绝 root/global scope 中已经注册的同名公开工具；随后注册的 root/global 工具仍保留 ToolRuntime 的普通 scoped-shadow 顺序。由连接拥有的 teardown 会一并释放 Agent scope 和它的 MCP 子项；ACP 不公开单会话关闭操作。

完整的协议和映射规则见 [ACP package README](../../../../packages/acp/acp/README.md) 与 [MCP client README](../../../../packages/mcp/mcp-client/README.md)。

## 验证

ACP 单元测试固定支持的 stdio 与 HTTP 声明、capability 公布、preflight 拒绝、安全错误映射、未发布 Agent 的回滚和 scoped 清理。真实 ACP E2E 会启动 stdio 与 Streamable HTTP fixture 服务器，验证发现和 `tools/call`，并覆盖同名并发会话和启动回滚。无密钥 `dynamic-mcp` 快照通过组装后的 ACP 示例回放真实 stdio fixture，并固定 scoped schema、工具调用、工具结果、session JSONL 和协议 stdout，不记录配置中的 secret。

聚焦验证命令为 `pnpm exec vitest run packages/acp/acp/tests/mcp-config.spec.ts packages/acp/acp/tests/bridge.spec.ts packages/mcp/mcp-client/tests/apply.spec.ts packages/mcp/mcp-client/tests/reconnect.spec.ts`、`pnpm exec vitest run --config vitest.e2e.config.ts packages/acp/acp/tests/dynamic-mcp.e2e.ts` 和 `pnpm exec vitest run --config vitest.snapshot.config.ts examples/acp-agent/tests/acp.snapshot.ts -t dynamic-mcp`。

## 曾考虑的替代方案

- **在 root 或 global 中挂载 MCP**：否决，因为每个 ACP 会话会共享同一组注册和生命周期，违反按会话隔离能力的要求。
- **在发布 Agent 后挂载**：否决，因为成功的 `session/new` 可能暴露一个不含所请求工具的 Agent，且无法原子回滚完整 setup。
- **把 SSE 或 ACP 传输当作 HTTP 接受**：否决，因为 MCP client 只实现 stdio 和 Streamable HTTP；capability 公布和校验保持精确。

## 后果

ACP 调用方可以为并发会话附加相互独立的 MCP 工具集合，包括同名服务器；启动失败不会留下已发布的半成品会话。受信任的 ACP 宿主仍负责对能够请求本地命令或网络 endpoint 的调用方授权；请求校验能阻止不安全的协议映射，但不是 sandbox。单会话的提前释放需要未来的 ACP 协议操作。
