/**
 * Deriving a connection profile for another container — in either direction.
 *
 * The root from a PDB, and a PDB from the root. They are the same move, and
 * having only the first was an asymmetry a user would feel immediately: the
 * estate view lists a dozen pluggable databases and then leaves you to type a
 * connection by hand for each one.
 *
 * **Why this exists, from Oracle's own documentation.** The *Multitenant
 * Administrator's Guide* is explicit: *"a user whose current container is a PDB
 * can view data for that PDB only."* The `CDB_*` views and a whole-estate
 * `V$CONTAINERS` answer are reachable from the CDB root and nowhere else, and
 * `CONTAINER = ALL` requires the current container to be the root. So the estate
 * features are not gated by a missing privilege that a DBA could grant — they
 * are gated by **which container you connected to**, which no grant changes.
 *
 * The same guide gives the way across: *"clients access the root or a PDB through
 * database services"*, and each PDB has a default service named after it. Reaching
 * the root is therefore not new infrastructure — it is the same host and port with
 * a different service name, i.e. one more connection profile.
 *
 * That is the whole of this module: take the profile the user is on, swap the
 * service, and hand back something the connection list can hold. Creating it is a
 * **free** capability, because connections are never counted, capped or metered
 * in this product and a way out of a limitation must never sit behind the paywall
 * that the limitation feeds.
 *
 * What it deliberately does NOT do:
 *
 *  - **Guess the root service name.** There is no rule that derives it from a PDB
 *    name — an administrator chooses both. The product proposes the database name
 *    reported by `SYS_CONTEXT('USERENV','DB_NAME')`, which is the conventional
 *    default and is a *measurement of this instance* rather than a guess, and then
 *    lets the user correct it before anything is saved.
 *  - **Assume the credentials carry over.** Connecting to the root usually needs a
 *    common user (`C##…`) or an administrative account; the PDB's local user very
 *    often cannot. The password is asked for on first connect like any other
 *    profile, and the user name is left editable for the same reason.
 *  - **Touch wallet profiles' TNS alias.** A wallet profile's connect string is an
 *    alias resolved from `tnsnames.ora`, not a host/port/service triple, so there
 *    is nothing here to rewrite. Those are refused with an explanation rather than
 *    mangled.
 */

import type { ProfileConfig } from './manager';

/** Split `host:port/service`, which is all Easy Connect needs to be for this. */
const EASY_CONNECT = /^(?<host>[^/\s]+?)(?::(?<port>\d+))?\/(?<service>[^/\s?]+)(?<rest>[?].*)?$/;

export interface RootProfileProposal {
  /** The profile to add, ready for the settings list. */
  profile: ProfileConfig;
  /** The service name that was swapped in, so the UI can let the user edit it. */
  service: string;
}

/**
 * Swap the service in an Easy Connect string, keeping everything else.
 *
 * The one operation both directions need. Reaching the root from a PDB and
 * reaching a PDB from the root are the *same* move — Oracle's Multitenant guide
 * says clients reach the root or a PDB through database services, and each PDB
 * has a default service named after it — so they share this function rather than
 * growing two nearly-identical ones that drift.
 */
function swapService(connectString: string, service: string): string {
  const m = EASY_CONNECT.exec(connectString.trim());
  if (!m?.groups) {
    throw new Error(
      `Could not read “${connectString}” as host:port/service, so there is nothing ` +
        'to swap the service name in. Add the connection by hand.',
    );
  }
  const { host, port, rest } = m.groups;
  return `${host}${port ? `:${port}` : ''}/${service}${rest ?? ''}`;
}

/**
 * Derive a profile for a SIBLING container — a PDB reached from the root, or any
 * other container whose service you know.
 *
 * The mirror image of `proposeRootProfile`, and the half that was missing: the
 * estate view would list a dozen pluggable databases and leave the user to type
 * a connection by hand for each. Free for the same reason as its twin —
 * connections are never counted here, and the way out of "you can only see the
 * container you connected to" cannot be the paid half.
 *
 * The user is carried over and left editable: a common user in the root usually
 * *can* log in to a PDB, unlike the reverse, but "usually" is not a promise this
 * function is entitled to make on someone's security model.
 */
export function proposePdbProfile(
  source: ProfileConfig,
  pdbName: string,
  existingIds: readonly string[] = [],
): RootProfileProposal {
  if (source.kind === 'wallet') {
    throw new Error(
      'This is a wallet connection, and its connect string is a TNS alias rather than a ' +
        'host and service. Add the connection by picking that PDB’s alias from your ' +
        'tnsnames.ora — AuspexLens cannot derive it.',
    );
  }
  const service = pdbName.trim();
  if (service === '') throw new Error('No pluggable database name given.');

  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    profile: {
      ...source,
      id: uniqueId(`${source.id}-${slug}`, existingIds),
      label: `${stripContainerSuffix(source.label)} — ${service}`,
      connectString: swapService(source.connectString, service),
      user: source.user,
    },
    service,
  };
}

/**
 * Keep labels from accreting.
 *
 * Deriving a PDB profile from a root profile that was itself derived would
 * otherwise produce "Sales (prod) — CDB root — SALESPDB", which reads like a
 * path rather than a name. One hop of history is enough.
 */
function stripContainerSuffix(label: string): string {
  return label.replace(/\s+—\s+CDB root$/, '');
}

/**
 * Build the root profile a PDB profile implies.
 *
 * @param source     the profile currently connected
 * @param dbName     `SYS_CONTEXT('USERENV','DB_NAME')` — the conventional root
 *                   service on a default installation, measured not assumed
 * @param existingIds ids already in the settings list, so the new one is unique
 * @throws when the source cannot be rewritten, with a message that says why
 */
export function proposeRootProfile(
  source: ProfileConfig,
  dbName: string,
  existingIds: readonly string[] = [],
): RootProfileProposal {
  if (source.kind === 'wallet') {
    throw new Error(
      'This is a wallet connection, and its connect string is a TNS alias rather than a ' +
        'host and service. Add a root connection by picking the alias for the CDB root from ' +
        'your tnsnames.ora — AuspexLens cannot derive it.',
    );
  }
  const service = dbName.trim();
  if (service === '') {
    throw new Error('The database did not report a name to use as the root service.');
  }

  const connectString = swapService(source.connectString, service);

  return {
    profile: {
      ...source,
      id: uniqueId(`${source.id}-root`, existingIds),
      label: `${source.label} — CDB root`,
      connectString,
      // Carried over so the user has something to edit rather than an empty box.
      // Very often it will need changing: a PDB's local user cannot log in to the
      // root, which the UI says out loud.
      user: source.user,
    },
    service,
  };
}

/** `id`, or `id-2`, `id-3`… — never silently overwriting an existing profile. */
function uniqueId(id: string, existing: readonly string[]): string {
  if (!existing.includes(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/**
 * What the user is told before the profile is saved.
 *
 * It names the two things that will surprise them otherwise: the service is a
 * convention rather than a fact about their installation, and the account almost
 * certainly has to change. Saying so here costs a sentence; not saying it costs a
 * support ticket that reads "AuspexLens created a connection that does not work".
 */
export function rootProfileAdvice(service: string, user: string): string {
  return (
    `This adds a connection to the service “${service}”, which is the usual name for the CDB ` +
    `root on this database. The account is carried over as “${user}” — a PDB-local user normally ` +
    'cannot log in to the root, so you will likely need a common user (C##…) or an ' +
    'administrative account. Both are editable before you connect.'
  );
}
