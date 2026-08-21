/**
 * The loopback bridge, on the extension-host side.
 *
 * The MCP server is a separate process — that is how the protocol works — and it
 * needs the database connection the extension already holds. This is the only
 * channel between them.
 *
 * Threat T3/T18. **"It is local" is not a control.** Anything else running as the
 * same user can open a socket to 127.0.0.1, and on a shared or compromised
 * machine that includes things you did not start. So:
 *
 *  - bound to **127.0.0.1 only**, never 0.0.0.0, so nothing off-box can reach it;
 *  - an **ephemeral port**, so there is no well-known port to find;
 *  - a **per-session secret** required on every request, compared in constant
 *    time (`tokenMatches`);
 *  - the secret and port reach the child **through its environment**, never
 *    through a file or a command-line argument — `ps` output is readable by other
 *    users on many systems.
 *
 * The bridge exposes exactly the tool dispatcher and nothing else. It cannot run
 * arbitrary SQL, because `handleTool` cannot: everything goes through the guard.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tokenMatches, newSessionSecret } from './bridge';
import { handleTool } from './handlers';
import type { HandlerContext } from './handlers';

export interface BridgeHandle {
  port: number;
  secret: string;
  close(): Promise<void>;
}

/** Header carrying the session secret. */
export const BRIDGE_AUTH_HEADER = 'x-auspexlens-session';

/** Body cap. A bridge that will read an unbounded body is a way to exhaust the
 *  extension host's memory from another process on the same machine. */
const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startBridge(
  contextFor: () => HandlerContext | undefined,
): Promise<BridgeHandle> {
  const secret = newSessionSecret();

  const server = http.createServer((req, res) => {
    void (async () => {
      const fail = (status: number, message: string) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      };

      // Authenticate BEFORE looking at anything else about the request. A bridge
      // that parses first and authenticates second has already done work for an
      // unauthenticated caller.
      if (!tokenMatches(secret, req.headers[BRIDGE_AUTH_HEADER])) {
        return fail(401, 'unauthorised');
      }
      if (req.method !== 'POST' || req.url !== '/tool') {
        return fail(404, 'not found');
      }

      let payload: { name?: unknown; args?: unknown };
      try {
        payload = JSON.parse(await readBody(req)) as typeof payload;
      } catch (e) {
        return fail(400, (e as Error).message);
      }

      if (typeof payload.name !== 'string') {
        return fail(400, "'name' is required");
      }

      const ctx = contextFor();
      if (!ctx) {
        return fail(409, 'no active AuspexLens connection — connect in the editor first.');
      }

      try {
        const result = await handleTool(
          ctx,
          payload.name,
          (payload.args as Record<string, unknown>) ?? {},
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        // The refusal message is the useful part — it tells the model what it may
        // not do, which is how it stops trying. Status 400, not 500: this is the
        // guard working, not the server failing.
        return fail(400, (e as Error).message);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 explicitly. The default binds every interface, which would put
    // the bridge on the network.
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as AddressInfo).port;

  return {
    port,
    secret,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
