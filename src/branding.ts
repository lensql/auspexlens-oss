/**
 * The one place in the free extension that is allowed to name the paid one.
 *
 * `scripts/ci/export-guards.sh` keeps an explicit allowlist of files that may
 * name the paid extension — today this file and README.md — and it additionally
 * requires the name to appear ONLY as the full Marketplace id. A private
 * repository URL or a source path would match the bare suffix too, and those must
 * never reach the public mirror.
 *
 * That strictness is why this very comment says "the paid extension" instead of
 * spelling the suffix out: the guard cannot tell a mention from a use, and the
 * right response to that is to write the comment differently, not to loosen a
 * control that stops a private path from being published.
 *
 * Adding a file to that allowlist is a decision about what the public repo may
 * name. The guard makes it loud on purpose rather than inferring intent.
 */

export const PRODUCT_NAME = 'AuspexLens';

/** Descriptive only. Oracle's trademark guidelines permit "X for Oracle
 *  Database" and forbid both containing "Oracle" in the name and any "Ora-"
 *  prefix — which is why the product is not called what it obviously would be. */
export const PRODUCT_TAGLINE = 'AuspexLens for Oracle Database';

export const BASE_EXTENSION_ID = 'lensql.auspexlens';
export const PRO_EXTENSION_ID = 'lensql.auspexlens-pro';

export const DOCS_URL = 'https://lensql.dev/auspexlens/';
export const PRICING_URL = 'https://lensql.dev/auspexlens/pricing';
export const BUY_URL = 'https://lensql.dev/auspexlens/buy';
export const EULA_URL = 'https://lensql.dev/auspexlens/eula';
export const SUPPORT_EMAIL = 'support@lensql.dev';

/** The licence service. Shared endpoint, product-specific key and payload — see
 *  PRODUCT-BASELINE §4.2/§4.3. */
export const LICENCE_API = 'https://api.lensql.dev';

/** The public mirror. `-oss`, and the suffix matters: the private repo is
 *  `lensql/auspexlens` and must never appear in anything shipped. */
export const PUBLIC_REPO_URL = 'https://github.com/lensql/auspexlens-oss';
