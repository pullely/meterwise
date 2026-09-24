// Instance identity for the CLI (saas-bootstrap-factory BF3 seam).
//
// The binary name, default API endpoint, OS keychain service, and config
// directory live here so a rebranded instance retargets one file. The
// `@saas/sdk` client class name (`Meterwise`) is intentionally NOT part of
// this seam — it is a code identifier, handled by the blueprint rename map
// (BF12), not a runtime value.

/** CLI binary name (matches `bin` in package.json). */
export const CLI_BIN = "meterwise";

/** Product/brand name used in human-facing CLI copy. */
export const PRODUCT_NAME = "Meterwise";

/** Default API base URL when `--api-url` is not supplied. */
export const DEFAULT_API_URL = "https://api.meterwise.app";

/** OS keychain service name for stored credentials. */
export const KEYCHAIN_SERVICE = `${CLI_BIN}-cli`;

/** Directory name under `~/.config` for the file-based token/config store. */
export const CONFIG_APP_DIR = CLI_BIN;

/** Env var overriding the config directory (used heavily by tests). */
// Hyphens map to underscores so a hyphenated CLI_BIN (e.g. "acme-cloud")
// still derives a valid env var name.
export const CONFIG_DIR_ENV_VAR = `${CLI_BIN.toUpperCase().replace(/-/g, "_")}_CONFIG_DIR`;
