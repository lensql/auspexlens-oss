/**
 * What you ran, and what you meant to keep.
 *
 * Two different needs that a single list would serve badly. **History** is
 * automatic, capped and disposable: you want the statement you ran twenty
 * minutes ago and cannot remember. **Saved queries** are deliberate and
 * permanent: you named them because you will want them next month.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT STORE
 *
 * `builtOn: 'local storage only'` in `tiers.ts` is a commitment, not a note.
 * Nothing here leaves the machine, and nothing here holds a result — only the
 * statement text.
 *
 * That second half matters more than it looks. This product masks personal data
 * in the engine, before results reach the grid, the exports or the MCP server. A
 * history that cached rows would be a copy of production data sitting in VS
 * Code's global state, outside every control the rest of the product is built
 * on. So history remembers what was asked, never what came back.
 *
 * The statement itself can still carry a secret — someone types a literal into a
 * WHERE clause — which is why `redactLiterals` exists and why history is capped
 * rather than kept forever.
 * ---------------------------------------------------------------------------
 */

/** One statement, and when it ran. */
export interface HistoryEntry {
  sql: string;
  /** Epoch milliseconds. Stored as a number so ordering never depends on a locale. */
  at: number;
  /** Which connection profile it ran against, for the ones that look alike. */
  profileId?: string;
  /** How long it took, when the run completed. Absent for a failure. */
  elapsedMs?: number;
}

export interface SavedQuery {
  name: string;
  sql: string;
  /** When it was saved or last overwritten. */
  at: number;
}

/**
 * How many statements history keeps.
 *
 * A cap rather than a time window: a person who runs three queries a week would
 * lose everything to a seven-day window, and one who runs three hundred a day
 * would keep a week of production literals. Counting is the honest measure of
 * "recent" for both.
 */
export const HISTORY_LIMIT = 200;

/**
 * Add a statement to the front of the history.
 *
 * Deduplicates against the most recent entry only, not the whole list. Running
 * the same query three times in a row is one thing you did; running it now and
 * again an hour later is two, and collapsing those would erase the timeline that
 * makes history worth having.
 *
 * Pure: takes the list, returns a new one. The caller owns storage.
 */
export function pushHistory(
  history: readonly HistoryEntry[],
  entry: HistoryEntry,
  limit = HISTORY_LIMIT,
): HistoryEntry[] {
  const sql = entry.sql.trim();
  if (sql === '') return [...history];
  const head = history[0];
  if (head && head.sql.trim() === sql && head.profileId === entry.profileId) {
    // Same statement, same connection, consecutively: keep one entry and move its
    // clock forward, so "when did I last run this" stays answerable.
    return [{ ...head, at: entry.at, elapsedMs: entry.elapsedMs }, ...history.slice(1)];
  }
  return [{ ...entry, sql }, ...history].slice(0, limit);
}

/**
 * A one-line label for a statement, for a picker.
 *
 * Collapses whitespace so a query formatted across twelve lines does not become
 * twelve lines of picker, and truncates on a character count rather than a word
 * boundary — a SQL statement has no words worth preserving at the cut, and a
 * predictable width is what makes a list scannable.
 */
export function summarise(sql: string, width = 90): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/**
 * Hide string and numeric literals in a statement.
 *
 * For showing history somewhere it might be read over a shoulder or pasted into
 * a ticket. It is **not** a security control and must never be described as one:
 * a literal is only one of the places a secret can hide, and this cannot find a
 * table named after a customer.
 *
 * What it is: the same courtesy the results grid already extends to values,
 * applied to the statement — because a WHERE clause with a national ID in it is
 * the commonest way one ends up on screen.
 */
export function redactLiterals(sql: string): string {
  return sql
    // Single-quoted strings, honouring Oracle's doubled-quote escape.
    .replace(/'(?:[^']|'')*'/g, "'…'")
    // Bare numbers, but not the ones inside identifiers like T1 or COL_2.
    .replace(/(^|[^A-Za-z0-9_$#])\d+(\.\d+)?/g, '$1…');
}

/**
 * Store a query under a name, replacing any query already using it.
 *
 * Sorted by name rather than by recency: a saved query is looked up by what you
 * called it, and a list that reorders itself under you is a list you have to
 * read every time.
 */
export function saveQuery(
  saved: readonly SavedQuery[],
  name: string,
  sql: string,
  at: number,
): SavedQuery[] {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('A saved query needs a name.');
  if (sql.trim() === '') throw new Error('There is nothing to save.');
  const rest = saved.filter((q) => q.name !== trimmed);
  return [...rest, { name: trimmed, sql: sql.trim(), at }]
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove one by name. Returns the list unchanged when the name is not there. */
export function removeQuery(saved: readonly SavedQuery[], name: string): SavedQuery[] {
  return saved.filter((q) => q.name !== name);
}

/**
 * How long ago, in words, without pulling in a date library.
 *
 * Minutes and hours are what a person asks history for; anything older than a
 * day gets a date, because "eleven days ago" is a number nobody converts.
 */
export function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toISOString().slice(0, 10);
}
