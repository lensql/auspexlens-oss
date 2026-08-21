/**
 * The local bridge between the MCP child process and the extension host.
 *
 * Threat T3. The MCP server runs as a separate process — that is how the protocol
 * works — and it needs to reach the connection the extension already holds. The
 * channel is local, and **"it is local" is not a control**: anything else running
 * as the same user can talk to a localhost port.
 *
 * So every request carries a secret generated fresh per session, compared in
 * constant time. A session secret is not stored, not logged, and does not
 * survive a restart.
 */

/** Constant-time-ish comparison. Returns false on any shape mismatch. */
export function tokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  // Compare over a fixed length so a wrong-length token costs the same as a
  // wrong-content one. A plain `===` returns early and leaks length by timing.
  const a = expected;
  const b = presented;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** A fresh secret per session. Never derived from anything guessable. */
export function newSessionSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
