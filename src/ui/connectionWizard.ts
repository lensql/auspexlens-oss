/**
 * Adding a connection without editing settings.json by hand.
 *
 * Until 1.7.0 AuspexLens had no way to create a connection from the interface.
 * `Connect` with no profiles configured answered with a sentence telling you to
 * go and edit a settings key — which is not an onboarding, it is a dead end with
 * instructions. RedLens has had a wizard since its first release, and the gap was
 * the single largest difference between the two products' first five minutes.
 *
 * The rules this follows are RedLens's, because they were right:
 *
 *  - **Contextual defaults per connection kind.** Oracle's listener port is 1521
 *    and an Autonomous service ends in `_high`; a wizard that starts every field
 *    blank makes the user supply what the tool already knows.
 *  - **Never a blank field without a hint.** Every prompt carries an example of
 *    the shape it wants, because "service name" means nothing to someone who has
 *    a connect string in front of them.
 *  - **Test before save.** A profile that does not connect is worse than no
 *    profile: it fails later, somewhere else, with the wizard long forgotten.
 *
 * ---------------------------------------------------------------------------
 * The pure half lives here and the VS Code half does not.
 *
 * Everything below is a function of its arguments: the kinds on offer, the
 * validation, and the profile that comes out. The command in `extension.ts`
 * supplies the QuickPick and the InputBoxes. That split is what makes any of this
 * testable at all — a multi-step QuickInput flow cannot be driven from a unit
 * test, and the part that would actually break under a rename or a bad default
 * is the part that does not need one.
 * ---------------------------------------------------------------------------
 */

import type { ProfileConfig } from '../connections/manager';

/** How a person describes what they are connecting to. */
export type ConnectionKindId = 'easy-connect' | 'wallet' | 'tns-alias';

export interface ConnectionKind {
  id: ConnectionKindId;
  /** Shown in the picker, with a codicon so the list reads at a glance. */
  label: string;
  /** The second line: what this choice actually is, in the user's terms. */
  detail: string;
  /** Which of the profile's fields this kind needs answered. */
  asks: readonly WizardField[];
}

export type WizardField = 'label' | 'host' | 'port' | 'service' | 'user' | 'alias' | 'configDir';

/**
 * The three ways an Oracle connection is described, in the order a person is
 * likely to want them.
 *
 * Wallet comes second rather than last because it is the Autonomous Database
 * path, and Autonomous is what a new Oracle user is most likely to have. It
 * hands off to the import command rather than duplicating it — that command
 * already reads the `.zip`, writes `tnsnames.ora` and stores the key in the OS
 * keychain, and a second implementation would be a second thing to get wrong.
 */
export function connectionKinds(): ConnectionKind[] {
  return [
    {
      id: 'easy-connect',
      label: '$(plug) Host, port and service name',
      detail: 'The usual case — an Oracle listener you can reach directly. Easy Connect.',
      asks: ['label', 'host', 'port', 'service', 'user'],
    },
    {
      id: 'wallet',
      label: '$(key) Oracle wallet (Autonomous Database)',
      detail: 'The .zip you download from Autonomous Database, or the folder you unzipped it into.',
      asks: [],
    },
    {
      id: 'tns-alias',
      label: '$(file-directory) TNS alias from an existing tnsnames.ora',
      detail: 'You already have a wallet or a TNS directory on this machine.',
      asks: ['label', 'alias', 'configDir', 'user'],
    },
  ];
}

/** What the wizard proposes before the user types anything. */
export function defaultsFor(kind: ConnectionKindId): Record<string, string> {
  switch (kind) {
    case 'easy-connect':
      // 1521 is Oracle's registered listener port. Offering it saves the one
      // field that is the same on almost every installation.
      return { port: '1521', host: '', service: '', user: '' };
    case 'tns-alias':
      return { alias: '', configDir: '', user: '' };
    case 'wallet':
      return {};
  }
}

/** The example shown under each prompt. Never a blank field without a hint. */
export function hintFor(field: WizardField): string {
  switch (field) {
    case 'label':     return 'Sales (production)';
    case 'host':      return 'db.example.com';
    case 'port':      return '1521';
    case 'service':   return 'ORCLPDB1  — the service name, not the SID';
    case 'user':      return 'app_reader';
    case 'alias':     return 'mydb_high  — an alias from tnsnames.ora';
    case 'configDir': return '/Users/you/wallets/mydb  — the folder holding tnsnames.ora';
  }
}

export interface WizardAnswers {
  label?: string;
  host?: string;
  port?: string;
  service?: string;
  user?: string;
  alias?: string;
  configDir?: string;
}

/**
 * Everything wrong with the answers, in the order the fields were asked.
 *
 * Returns a list rather than throwing on the first problem: a wizard that
 * reports one error at a time makes the user run it three times to learn three
 * things.
 */
export function validateAnswers(kind: ConnectionKindId, a: WizardAnswers): string[] {
  const errors: string[] = [];
  const need = (v: string | undefined, what: string) => {
    if (!v || v.trim() === '') errors.push(`${what} is required.`);
  };
  need(a.label, 'A name for this connection');
  if (kind === 'easy-connect') {
    need(a.host, 'The host');
    need(a.service, 'The service name');
    need(a.user, 'The user');
    const port = Number(a.port);
    if (!a.port || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push('The port must be a whole number between 1 and 65535.');
    }
    // The commonest paste: a whole connect string dropped into the host box.
    if (a.host?.includes('/') || a.host?.includes(':')) {
      errors.push(
        'The host is just the hostname — put the service after it in its own field, ' +
          'and the port in the port field.',
      );
    }
  }
  if (kind === 'tns-alias') {
    need(a.alias, 'The TNS alias');
    need(a.configDir, 'The folder holding tnsnames.ora');
    need(a.user, 'The user');
  }
  return errors;
}

/**
 * Turn the answers into a profile the connection list can hold.
 *
 * The id is derived from the label rather than asked for: an id is a detail of
 * how this product stores things, and asking a user to invent one is asking them
 * to care about our storage. Uniqueness is enforced here so a second "Sales"
 * cannot silently replace the first.
 *
 * @throws when the answers do not validate — the caller has already shown the
 *         errors, and building a profile from them anyway is how a broken one
 *         reaches settings.json.
 */
export function buildProfile(
  kind: ConnectionKindId,
  a: WizardAnswers,
  existingIds: readonly string[] = [],
): ProfileConfig {
  const errors = validateAnswers(kind, a);
  if (errors.length > 0) throw new Error(errors.join(' '));

  const label = a.label!.trim();
  const id = uniqueId(slug(label), existingIds);
  if (kind === 'tns-alias') {
    return {
      id, label, user: a.user!.trim(), kind: 'wallet',
      connectString: a.alias!.trim(),
      configDir: a.configDir!.trim(),
    };
  }
  return {
    id, label, user: a.user!.trim(), kind: 'basic',
    connectString: `${a.host!.trim()}:${Number(a.port)}/${a.service!.trim()}`,
  };
}

/** A readable id from a label: lower case, words joined by dashes. */
export function slug(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s === '' ? 'connection' : s;
}

function uniqueId(id: string, existing: readonly string[]): string {
  if (!existing.includes(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/**
 * One line describing a profile, for the manage-connections picker.
 *
 * The connect string is the description because it is what distinguishes two
 * connections that a person named carelessly — and "Sales" against "Sales copy"
 * is exactly the pair where picking wrong costs the most.
 */
export function describeProfile(p: ProfileConfig): { label: string; description: string } {
  return {
    label: p.label,
    description: p.kind === 'wallet'
      ? `${p.user}@${p.connectString} (wallet)`
      : `${p.user}@${p.connectString}`,
  };
}
