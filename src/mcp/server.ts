/**
 * The MCP server process.
 *
 * Bundled separately as `dist/mcp-server.js` and launched as a child process by
 * whatever agent the user points at it. It holds no database connection of its
 * own: every tool call goes back over the loopback bridge to the extension host,
 * which owns the connection and the guard.
 *
 * That indirection is the design, not an accident of packaging. If this process
 * held a connection it would be a second path into the database, living outside
 * the extension, reachable by whatever started it. One path, one guard.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools';
import { BRIDGE_AUTH_HEADER } from './bridgeServer';

const PORT = process.env['AUSPEXLENS_BRIDGE_PORT'];
const SECRET = process.env['AUSPEXLENS_BRIDGE_SECRET'];

if (!PORT || !SECRET) {
  // Refuse rather than start degraded. A server that answers "no connection" to
  // every call looks like a broken database and sends someone debugging Oracle.
  process.stderr.write(
    'AuspexLens MCP: AUSPEXLENS_BRIDGE_PORT and AUSPEXLENS_BRIDGE_SECRET must be set.\n' +
      'This process is started by the AuspexLens extension, not directly.\n',
  );
  process.exit(2);
}

async function callBridge(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${PORT}/tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [BRIDGE_AUTH_HEADER]: SECRET!,
    },
    body: JSON.stringify({ name, args }),
  });
  const body = (await res.json()) as { error?: string } & Record<string, unknown>;
  if (!res.ok) {
    throw new Error(body.error ?? `bridge returned ${res.status}`);
  }
  return body;
}

const server = new Server(
  { name: 'auspexlens', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await callBridge(name, (args as Record<string, unknown>) ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    // isError, not a thrown exception: the model should SEE the refusal and stop
    // trying, rather than receive a transport failure it will retry.
    return {
      content: [{ type: 'text', text: (e as Error).message }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
void server.connect(transport);
