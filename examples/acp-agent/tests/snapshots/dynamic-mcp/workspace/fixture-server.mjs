import readline from 'node:readline'

const tool = {
  name: 'add',
  description: 'Adds two numbers.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function isAddArguments(value) {
  return value !== null && typeof value === 'object'
    && typeof value.a === 'number' && typeof value.b === 'number'
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    process.stderr.write('dynamic-mcp fixture: ignored invalid JSON-RPC frame\n')
    continue
  }
  if (request === null || typeof request !== 'object' || !('method' in request)) {
    process.stderr.write('dynamic-mcp fixture: ignored invalid request\n')
    continue
  }
  if (!('id' in request)) continue
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'dynamic-mcp-fixture', version: '1.0.0' },
    })
    process.stderr.write('dynamic-mcp fixture: initialized\n')
    continue
  }
  if (request.method === 'tools/list') {
    respond(request.id, { tools: [tool] })
    process.stderr.write('dynamic-mcp fixture: listed tools\n')
    continue
  }
  if (request.method === 'tools/call' && request.params?.name === 'add' && isAddArguments(request.params.arguments)) {
    const { a, b } = request.params.arguments
    respond(request.id, { content: [{ type: 'text', text: String(a + b) }] })
    process.stderr.write('dynamic-mcp fixture: returned add result\n')
    continue
  }
  fail(request.id, -32601, 'Method not found')
}
