/**
 * Where credentials live, and where they must never live.
 *
 * Threat T7. VS Code's `SecretStorage` is encrypted by the operating system's
 * keychain; `settings.json` is a plain text file that people paste into issues,
 * commit to dotfile repos, and screen-share. The difference is the whole control.
 *
 * Nothing in this module returns a secret in a way that could reach a log. The
 * public surface is deliberately small: store, read, forget.
 */

/** The slice of `vscode.SecretStorage` used here, so this is testable without
 *  the extension host — and cannot reach for anything else. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/** What a connection profile keeps in SecretStorage. Everything else — host,
 *  port, service, user — is ordinary configuration and lives in settings. */
export type SecretKind = 'password' | 'walletPassword' | 'walletContent';

/**
 * Namespaced so a profile's secrets can be removed together and can never
 * collide with another extension's keys in the same keychain.
 */
export function secretKey(profileId: string, kind: SecretKind): string {
  if (!profileId || /[\s:]/.test(profileId)) {
    // A profile id with a colon in it could forge another profile's key.
    throw new Error(`invalid connection profile id: ${JSON.stringify(profileId)}`);
  }
  return `auspexlens:${profileId}:${kind}`;
}

export class CredentialStore {
  constructor(private readonly storage: SecretStorageLike) {}

  async put(profileId: string, kind: SecretKind, value: string): Promise<void> {
    await this.storage.store(secretKey(profileId, kind), value);
  }

  async get(profileId: string, kind: SecretKind): Promise<string | undefined> {
    return this.storage.get(secretKey(profileId, kind));
  }

  /** Remove every secret belonging to a profile. Called when a profile is
   *  deleted — a leftover password outliving its profile is a secret nobody is
   *  managing any more. */
  async forget(profileId: string): Promise<void> {
    for (const kind of ['password', 'walletPassword', 'walletContent'] as const) {
      await this.storage.delete(secretKey(profileId, kind));
    }
  }

  /**
   * Whether a secret is present, WITHOUT returning it.
   *
   * The UI needs to know if a profile is ready to connect; it does not need the
   * value, and a function that hands one back "just to check" is how a secret
   * ends up in a log line. Same rule as measuring the length of a 1Password
   * reference instead of printing it.
   */
  async has(profileId: string, kind: SecretKind): Promise<boolean> {
    return (await this.storage.get(secretKey(profileId, kind))) !== undefined;
  }
}

/**
 * The settings keys that must NEVER hold a secret.
 *
 * Checked by a test rather than trusted: this is the list a reviewer would have
 * to remember otherwise, and the mistake is a one-line convenience that looks
 * helpful in review.
 */
export const FORBIDDEN_SETTING_KEYS: readonly string[] = [
  'auspexlens.connections.password',
  'auspexlens.connections.walletPassword',
  'auspexlens.connections.walletContent',
];
