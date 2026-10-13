// stdio entry point of the fixture MCP server: `node mcp-echo-server.mjs`.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createFixtureServer } from './mcp-fixture-server.mjs'

if (process.env.FIXTURE_EXIT_AT_START === '1') {
  console.error('fixture: refusing to start (FIXTURE_EXIT_AT_START=1)')
  process.exit(7)
}
if (process.env.FIXTURE_HANG_AT_START === '1') {
  console.error('fixture: hanging before the handshake (FIXTURE_HANG_AT_START=1)')
  setInterval(() => undefined, 1000)
} else {
  const server = createFixtureServer()
  await server.connect(new StdioServerTransport())
  console.error('fixture: ready')
}
