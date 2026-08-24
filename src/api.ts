/**
 * The contract between the free extension and the paid one.
 *
 * This is the ONLY thing Pro may use from base. It is exported from base's
 * `activate()` and reached through `vscode.extensions.getExtension(...).exports`,
 * which is VS Code's supported way for one extension to expose an API to another
 * — there is no import across packages, and there must never be one: base is
 * mirrored to a public repository and Pro is not, so a direct import would either
 * break the mirror or leak Pro.
 *
 * **Versioned on purpose.** Base and Pro are published separately and a user can
 * end up with any combination of versions. `apiVersion` is what lets Pro say
 * "this base is too old" instead of failing on a missing method — RedLens learned
 * that the hard way when base shipped eight commands Pro implemented and nobody
 * noticed until the bridge smoke test existed.
 */

import type { ResultSet, ExecuteOptions } from './engine/readOnly';
import type { Privileges } from './catalog/privileges';
import type { ContainerInfo } from './engine/container';

/** Incremented when something is REMOVED or changes meaning. Adding is free. */
export const API_VERSION = 1;

export interface AuspexLensApi {
  apiVersion: number;
  /** The base extension's own version, for diagnostics. */
  version: string;

  /** Whether a connection is currently open. */
  isConnected(): boolean;

  /**
   * Run a read-only statement through the same guard, the same per-statement
   * read-only transaction and the same PII masking as everything else.
   *
   * Pro gets no privileged path into the database. That is deliberate: one path,
   * one guard, and a paid feature cannot become a way around a safety control.
   */
  executeReadOnly(sql: string, options?: ExecuteOptions): Promise<ResultSet>;

  /** What the current connection is allowed to see, for graceful degradation. */
  privileges(): Promise<Privileges | undefined>;

  /**
   * `EXPLAIN PLAN` + the structured PLAN_TABLE rows, as one operation.
   *
   * One call rather than two through `executeReadOnly`, because the engine
   * opens every ordinary query with a rollback that would erase the explain's
   * uncommitted rows. Added without bumping `apiVersion`: adding is free,
   * removing or changing meaning is what costs a version.
   */
  explainPlanRows(sql: string): Promise<{ columns: string[]; rows: unknown[][] }>;

  /**
   * Which container the active connection is in, or undefined when not connected.
   *
   * Free, and exposed to Pro rather than reimplemented there: knowing where you
   * are is a safety property, and the estate features need it to explain why a
   * PDB-scoped connection sees exactly one container instead of showing "1" and
   * letting the user conclude their CDB holds one. Added without bumping
   * `apiVersion` — adding is free, removing or changing meaning is what costs a
   * version.
   */
  currentContainer(): Promise<ContainerInfo | undefined>;
}
