import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Screenshot suite for the Marketplace listing (docs/LISTING-ASSETS.md): drives
 * a REAL connection to the compose Oracle inside the headless VS Code and
 * captures the Xvfb display with imagemagick at key moments.
 *
 * Unlike RedLens's suite this one photographs a live database, not an in-memory
 * demo: AuspexLens has no demo engine, and the compose fixtures are already
 * deterministic — synthetic rows, created identically on every `up`. The
 * connection itself goes through `auspexlens.connect` with a profile id (the
 * programmatic path) and the Test-mode password seed, so the product connects
 * the way a user's build of it does, QuickPick aside.
 *
 * NEVER awaits interactive commands (QuickPick, InputBox) — fire, sleep,
 * capture, close. An awaited dialog blocks the suite forever.
 */

const OUT_DIR = '/app/docs/listing/raw';

/** Where the compose database lives. Same variables as scripts/mac/test.sh. */
const HOST = process.env.AUSPEX_ORACLE_HOST ?? 'auspexlens-oracle-compat';
const PORT = process.env.AUSPEX_ORACLE_PORT ?? '1521';
const SERVICE = process.env.AUSPEX_ORACLE_SERVICE ?? 'FREEPDB1';
const CONNECT = `${HOST}:${PORT}/${SERVICE}`;

/**
 * Take the shot, after clearing everything that is not this product.
 *
 * The tidying lives HERE, in the shutter itself — RedLens learned that doing it
 * once at startup is not enough: the host's notifications ("extensions are
 * temporarily disabled", "not recommended to run Code as root") arrive during
 * activation, and panels come back on their own as views open.
 *
 * `keepNotices` is for the captures where a notification IS the subject — the
 * guard refusing a DROP, the over-privilege warning. Clearing it there would
 * photograph the absence of the feature.
 */
async function capture(name: string, opts: { keepNotices?: boolean; keepPanel?: boolean } = {}): Promise<void> {
  await tryCommand('workbench.action.closeAuxiliaryBar');
  // `keepPanel` exists because the first run of this suite proved the shutter
  // can kill its own subject: the Pro monitors present in the OUTPUT panel, and
  // the tidy-then-shoot sequence closed it, so three "monitor" captures were
  // byte-identical photographs of a leftover explain. Tidying is for what is
  // NOT the subject; the caller says which is which.
  if (opts.keepPanel !== true) {
    await tryCommand('workbench.action.closePanel');
  }
  if (opts.keepNotices !== true) {
    await tryCommand('notifications.clearAll');
  }
  await sleep(350);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execSync(`import -window root ${path.join(OUT_DIR, name)}`, { env: process.env });
  console.error(`captured ${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a command that may not exist in this workbench, and say so if it does not.
 * A swallowed error in a screenshot harness does not produce a missing image —
 * it produces a WRONG one, which is far harder to notice.
 */
async function tryCommand(id: string, ...args: unknown[]): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(id, ...args);
    return true;
  } catch (err) {
    console.error(`shots: '${id}' did not run — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Captures this run could not take, and why. Printed at the end. */
const skipped: string[] = [];

/**
 * Capture a panel that belongs to AuspexLens Pro.
 *
 * The harness lives in the free package; when Pro is not loaded its commands
 * are simply absent. Skipping is right, silence is not: an image the suite did
 * not produce has to be said out loud at the end, where it cannot be lost.
 */
async function proCapture(
  command: string,
  name: string,
  opts: { keepNotices?: boolean; keepPanel?: boolean } = {},
  ...args: unknown[]
): Promise<boolean> {
  if (!(await tryCommand(command, ...args))) {
    skipped.push(`${name} (needs AuspexLens Pro — '${command}' is not registered)`);
    return false;
  }
  await sleep(2500);
  await capture(name, opts);
  return true;
}

/** Put the workbench in a state worth photographing. */
async function quiet(): Promise<void> {
  await tryCommand('workbench.action.closeAuxiliaryBar');
  await tryCommand('workbench.action.closePanel');
  await tryCommand('notifications.clearAll');
  await sleep(400);
}

async function openSql(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  await sleep(700);
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('lensql.auspexlens');
  if (ext === undefined) {
    throw new Error('extension not found');
  }
  await ext.activate();

  const cfg = () => vscode.workspace.getConfiguration('auspexlens');

  // Two profiles, straight into settings — passwords are NOT here, they arrive
  // through the Test-mode seed in the connect command (AUSPEXLENS_TEST_PASSWORD).
  //
  // Two, because the shots need two different privilege shapes: the app owner
  // for the explorer/grid/guard captures, and the monitoring account — CREATE
  // SESSION + SELECT_CATALOG_ROLE, nothing else — for the Pro v$ panels, which
  // is exactly the account shape the Pro README tells a DBA to create.
  await cfg().update(
    'connections.profiles',
    [
      { id: 'shots-app', label: 'orders-dev (fixtures)', user: 'auspexlens', connectString: CONNECT, kind: 'basic' },
      { id: 'shots-mon', label: 'monitoring (catalog role)', user: 'auspexlens_mon', connectString: CONNECT, kind: 'basic' },
    ],
    vscode.ConfigurationTarget.Global,
  );

  // 0) Connect as the app owner. Awaited on purpose: the command resolves when
  //    the connection is open, and everything below needs it open.
  await vscode.commands.executeCommand('auspexlens.connect', 'shots-app');
  await sleep(1200);

  // 5) The over-privilege warning fires at connect time — this account owns its
  //    schema and can create objects, and the product says so out loud (§2 of
  //    CLAUDE.md). The first run photographed it BURIED: it fired during the
  //    activation storm and VS Code's three-toast stack had already hidden it
  //    behind the host's own notices. So: clear everything first, then invoke
  //    connect AGAIN — the manager reuses the open connection, but the command
  //    re-probes privileges and re-warns, which is exactly the behaviour a user
  //    reconnecting sees. The capture then holds only our two notifications.
  await quiet();
  console.error('shots: reconnect for the over-privilege capture…');
  await vscode.commands.executeCommand('auspexlens.connect', 'shots-app');
  console.error('shots: reconnect resolved');
  await sleep(1000);
  await tryCommand('workbench.action.closeAuxiliaryBar');
  // The toasts alone proved unreliable here: the run-2 capture came back empty
  // with no error anywhere. The notification CENTER is the deterministic form
  // of the same subject — it lists the live notifications with their FULL text,
  // where a toast truncates the one sentence that matters.
  await tryCommand('notifications.showList');
  await sleep(600);
  await capture('05-overprivilege-warning.png', { keepNotices: true, keepPanel: true });
  await tryCommand('notifications.hideList');

  await quiet();

  // 1) Explorer with the fixtures schema, expanded to the level that makes the
  //    shot an argument: AUSPEXLENS → Tables → the demo tables. `list.expandAll`
  //    does not exist in this workbench (measured, not assumed — run 1 printed
  //    the miss), and a blind expand-walk opened four schemas one folder deep,
  //    which photographs as an empty-looking tree. Two deliberate expands with
  //    time for the async children beat ten blind ones.
  await vscode.commands.executeCommand('workbench.view.extension.auspexlens');
  await sleep(2500);
  await tryCommand('list.focusFirst');       // AUSPEXLENS, the app schema
  await tryCommand('list.expand');
  await sleep(1000);                          // folder nodes arrive
  await tryCommand('list.focusDown');         // Tables
  await tryCommand('list.expand');
  await sleep(1800);                          // table rows arrive from ALL_OBJECTS
  await quiet();
  await capture('01-explorer.png');

  // 2) A join with enough rows to look like work, in the results grid.
  const joinSql =
    'SELECT i.invoice_no, c.full_name, i.status,\n' +
    '       i.total_cents / 100 AS total_usd, i.issued_on\n' +
    'FROM demo_invoices i\n' +
    'JOIN demo_customers c ON c.id = i.customer_id\n' +
    'ORDER BY i.issued_on DESC;\n';
  await openSql(joinSql);
  await vscode.commands.executeCommand('auspexlens.runQuery');
  await sleep(2500);
  await capture('02-results-grid.png');

  // 3) PII masking: the default mode is 'named', and these columns are named
  //    like what they are. The grid marks the masked columns — the capture is
  //    the engine-level control (T4) made visible.
  await tryCommand('workbench.action.closeAllEditors');
  await sleep(300);
  await openSql('SELECT full_name, email, phone, tax_id\nFROM demo_customers\nORDER BY id;\n');
  await vscode.commands.executeCommand('auspexlens.runQuery');
  await sleep(2500);
  await capture('03-pii-masking.png');

  // 4) Basic explain — the free tier's text plan, run outside the read-only
  //    transaction (the ORA-00604 special case that section 2 documents).
  await tryCommand('workbench.action.closeAllEditors');
  await sleep(300);
  await openSql(joinSql);
  await vscode.commands.executeCommand('auspexlens.explainQuery');
  await sleep(2500);
  await capture('04-explain-text.png');

  // 6) The guard refusing DDL in read-only mode. The refusal names the
  //    statement family and says why Oracle would not have stopped it — that
  //    error message is the product's whole thesis in one notification.
  await tryCommand('workbench.action.closeAllEditors');
  await sleep(300);
  await openSql('DROP TABLE demo_invoices;\n');
  await vscode.commands.executeCommand('auspexlens.runQuery');
  await sleep(1500);
  await capture('06-readonly-guard.png', { keepNotices: true });

  // 7) The typed-name confirmation on the explicit path: read-only off, the
  //    same DROP, and the dialog asks for the OBJECT'S NAME, not "yes".
  //    Fire WITHOUT awaiting — an InputBox blocks until answered — and close
  //    with Escape so nothing ever reaches the database.
  await cfg().update('readOnly.enabled', false, vscode.ConfigurationTarget.Global);
  await sleep(300);
  void vscode.commands.executeCommand('auspexlens.runQuery');
  await sleep(1800);
  await capture('07-risk-typed-confirm.png');
  await tryCommand('workbench.action.closeQuickOpen');
  await cfg().update('readOnly.enabled', true, vscode.ConfigurationTarget.Global);
  await sleep(300);

  // 10) Pro: the visual explain for the same join, plan tree plus advisors.
  await tryCommand('workbench.action.closeAllEditors');
  await sleep(300);
  await openSql(joinSql);
  await proCapture('auspexlens.pro.visualExplain', '10-visual-explain.png');

  // 11–13) Pro monitoring, connected as the account those panels are FOR:
  //    CREATE SESSION + SELECT_CATALOG_ROLE and nothing else. Two sessions are
  //    open at this point (app + monitoring), so v$session has real rows, and
  //    the queries above left entries in v$sql for Top SQL.
  await vscode.commands.executeCommand('auspexlens.connect', 'shots-mon');
  await sleep(1200);
  await quiet();
  // The monitors present in the OUTPUT panel (bottom), not a webview — that
  // panel IS the subject, so the shutter must keep it. The stray explain tab
  // from capture 10 gets closed first so the top half shows the editor.
  await tryCommand('workbench.action.closeAllEditors');
  await sleep(300);
  await openSql('-- Connected as auspexlens_mon: CREATE SESSION + SELECT_CATALOG_ROLE only\n');
  await proCapture('auspexlens.pro.sessionMonitor', '11-session-monitor.png', { keepPanel: true });
  await proCapture('auspexlens.pro.topSql', '12-top-sql.png', { keepPanel: true });
  await proCapture('auspexlens.pro.blockingTree', '13-blocking-tree.png', { keepPanel: true });

  if (skipped.length > 0) {
    console.error(`shots: ${skipped.length} capture(s) NOT taken:`);
    for (const s of skipped) {
      console.error(`  - ${s}`);
    }
  }
  console.error('SHOTS_OK');
}
