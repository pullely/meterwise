// CLI runner. The `bin/cli.ts` entrypoint is a thin wrapper that calls
// `runCli(process.argv.slice(2))`; this module owns the dispatch logic so
// it stays unit-testable.

import { Meterwise } from "@saas/sdk";

import { CLI_BIN, PRODUCT_NAME } from "./brand.js";
import { Router, parseArgv } from "./router.js";
import {
  loginCommand,
  logoutCommand,
  whoamiCommand,
  orgListCommand,
  orgUseCommand,
  orgMembersCommand,
  projectListCommand,
} from "./commands/index.js";
import {
  orgInviteCommand,
  projectCreateCommand,
  envCreateCommand,
  apiKeyCreateCommand,
  webhookCreateCommand,
} from "./commands/writes.js";
import { makeWebhookVerifyCommand, type WebhookVerifyOptions } from "./commands/webhook-verify.js";
import { makeWebhookSignCommand, type WebhookSignOptions } from "./commands/webhook-sign.js";
import { webhookSecretsRotateCommand } from "./commands/webhook-secrets-rotate.js";
import { webhookEnableCommand } from "./commands/webhook-enable.js";
import { webhookDisableCommand } from "./commands/webhook-disable.js";
import { webhookDeliveriesCommand } from "./commands/webhook-deliveries.js";
import { webhookDeliveriesReplayCommand } from "./commands/webhook-deliveries-replay.js";
import { securityEventsCommand } from "./commands/security-events.js";
import {
  notificationPreferencesGetCommand,
  notificationPreferencesSetCommand,
} from "./commands/notification-preferences.js";
import { integrationsGithubTokenCommand } from "./commands/integrations-token.js";
import {
  usageSummaryCommand,
  billingSummaryCommand,
  auditListCommand,
} from "./commands/cross-reads.js";
import { parseOutputMode, type OutputMode } from "./output/index.js";
import { ContextStore } from "./context/store.js";
import { selectTokenStore } from "./token-store/index.js";
import type { TokenStore } from "./token-store/types.js";
import { CLI_VERSION } from "./version.js";
import {
  formatCliError,
  MissingAuthError,
  UsageError,
} from "./errors.js";

export interface RunOptions {
  /** Override stdout sink (tests). */
  readonly stdout?: (line: string) => void;
  /** Override stderr sink (tests). */
  readonly stderr?: (line: string) => void;
  /** Inject a token store (tests). */
  readonly tokenStore?: TokenStore;
  /** Inject a context store (tests). */
  readonly contextStore?: ContextStore;
  /** Override SDK factory (tests). */
  readonly sdkFactory?: (baseUrl: string, token: string) => Meterwise;
  /** Override config dir for the file token store / context store. */
  readonly configDir?: string;
  /**
   * Test injection for the `webhook verify` command — supplies a
   * synthetic stdin and a fixed `now()` so verification can be exercised
   * deterministically without poking `process.stdin` or the system clock.
   */
  readonly webhookVerify?: WebhookVerifyOptions;
  /**
   * Test injection for the `webhook sign` command — supplies a
   * synthetic stdin so signing can be exercised deterministically
   * without poking `process.stdin`.
   */
  readonly webhookSign?: WebhookSignOptions;
}

export async function runCli(
  argv: ReadonlyArray<string>,
  opts: RunOptions = {},
): Promise<{ exitCode: number }> {
  const stdout = opts.stdout ?? defaultStdout;
  const stderr = opts.stderr ?? defaultStderr;

  const { positional, flags } = parseArgv(argv);

  const outputMode: OutputMode = parseOutputMode(flags["output"]);

  // Top-level meta flags handled before routing.
  if (flags["version"] === true || positional[0] === "--version") {
    if (outputMode === "json") {
      stdout(JSON.stringify({ version: CLI_VERSION }));
    } else {
      stdout(CLI_VERSION);
    }
    return { exitCode: 0 };
  }
  if (flags["help"] === true || positional.length === 0) {
    printHelp(stdout);
    return { exitCode: positional.length === 0 ? 0 : 0 };
  }

  const router = buildRouter(opts);
  const match = router.resolve(positional);
  if (match === null) {
    const formatted = formatCliError({
      err: new UsageError(`unknown command: ${positional.join(" ")}`),
      mode: outputMode,
    });
    stderr(formatted.message);
    if (outputMode === "human") printUsageHint(stderr);
    return { exitCode: formatted.exitCode };
  }

  const tokenStore =
    opts.tokenStore ??
    (await selectTokenStore(
      opts.configDir !== undefined ? { configDir: opts.configDir } : {},
    ));
  const contextStore =
    opts.contextStore ??
    new ContextStore(opts.configDir !== undefined ? { configDir: opts.configDir } : {});

  const sdk = async (): Promise<Meterwise> => {
    const cred = await tokenStore.load();
    if (!cred) throw new MissingAuthError();
    if (opts.sdkFactory) return opts.sdkFactory(cred.apiUrl, cred.token);
    return new Meterwise({
      baseUrl: cred.apiUrl,
      auth: { kind: "bearer", token: cred.token },
    });
  };

  try {
    const result = await match.handler({
      args: match.rest,
      flags,
      outputMode,
      stdout,
      stderr,
      tokenStore,
      contextStore,
      sdk,
    });
    return { exitCode: result.exitCode };
  } catch (err) {
    const formatted = formatCliError({ err, mode: outputMode });
    stderr(formatted.message);
    return { exitCode: formatted.exitCode };
  }
}

function buildRouter(opts: RunOptions): Router {
  const r = new Router();
  const webhookVerifyHandler = makeWebhookVerifyCommand(opts.webhookVerify ?? {});
  const webhookSignHandler = makeWebhookSignCommand(opts.webhookSign ?? {});
  // Auth
  r.register(["login"], `Authenticate against a ${PRODUCT_NAME} API`, loginCommand);
  r.register(["logout"], "Clear stored credentials and context", logoutCommand);
  r.register(["whoami"], "Show the active identity and organization", whoamiCommand);
  // Organizations
  r.register(["org", "list"], "List organizations the actor belongs to", orgListCommand);
  r.register(["org", "use"], "Set the active organization", orgUseCommand);
  r.register(["org", "members"], "List members of the active organization", orgMembersCommand);
  r.register(["org", "invite"], "Invite a member to an organization", orgInviteCommand);
  // Projects
  r.register(["project", "list"], "List projects in the active organization", projectListCommand);
  r.register(["project", "create"], "Create a project in the active organization", projectCreateCommand);
  // Environments
  r.register(["env", "create"], "Create an environment under a project", envCreateCommand);
  // API keys
  r.register(["api-key", "create"], "Create an org-scoped API key", apiKeyCreateCommand);
  // Webhooks
  r.register(["webhook", "create"], "Create a webhook endpoint (and optional subscriptions)", webhookCreateCommand);
  r.register(["webhook", "verify"], "Verify a webhook signature locally (no network)", webhookVerifyHandler);
  r.register(["webhook", "sign"], "Sign a webhook payload locally (no network)", webhookSignHandler);
  r.register(["webhook", "secrets", "rotate"], "Rotate the signing secret for a webhook endpoint (reveal-once)", webhookSecretsRotateCommand);
  r.register(["webhook", "enable"], "Re-enable a previously disabled webhook endpoint", webhookEnableCommand);
  r.register(["webhook", "disable"], "Disable an active webhook endpoint", webhookDisableCommand);
  r.register(["webhook", "deliveries"], "List delivery attempts for a webhook endpoint", webhookDeliveriesCommand);
  r.register(["webhook", "deliveries", "replay"], "Replay a past webhook delivery attempt (re-send same event)", webhookDeliveriesReplayCommand);
  // Cross-resource reads
  r.register(["usage", "summary"], "Summarize usage rollups for the active organization", usageSummaryCommand);
  r.register(["billing", "summary"], "Show billing customer/plan/entitlements summary", billingSummaryCommand);
  r.register(["audit", "list"], "List audit log entries for the active organization", auditListCommand);
  // Account security events (actor-scoped — no --org)
  r.register(["security", "events"], "List account security events (actor-scoped)", securityEventsCommand);
  // Notification preferences (actor-scoped per org)
  r.register(["notifications", "preferences"], "Show your email notification preferences for an org", notificationPreferencesGetCommand);
  r.register(["notifications", "preferences", "set"], "Enable/disable an email notification category", notificationPreferencesSetCommand);
  r.register(["integrations", "github", "token"], "Mint a short-lived, repo-scoped GitHub installation token", integrationsGithubTokenCommand);
  return r;
}

function printHelp(stdout: (line: string) => void): void {
  stdout(
    [
      `${CLI_BIN} v${CLI_VERSION}`,
      "",
      "USAGE:",
      `  ${CLI_BIN} <command> [args] [--output=human|json]`,
      "",
      "AUTH:",
      `  ${CLI_BIN} login    [--api-url=URL] [--token=BEARER]`,
      `  ${CLI_BIN} logout`,
      `  ${CLI_BIN} whoami`,
      "",
      "ORGANIZATIONS:",
      `  ${CLI_BIN} org list`,
      `  ${CLI_BIN} org use <org-id>`,
      `  ${CLI_BIN} org members`,
      `  ${CLI_BIN} org invite <email> [--role=ROLE] [--idempotency-key=KEY] [--org=ORG_ID]`,
      "",
      "PROJECTS / ENVIRONMENTS:",
      `  ${CLI_BIN} project list`,
      `  ${CLI_BIN} project create <name> [--idempotency-key=KEY]`,
      `  ${CLI_BIN} env create <project-id> <name> [--idempotency-key=KEY]`,
      "",
      "API KEYS / WEBHOOKS:",
      `  ${CLI_BIN} api-key create <name> [--scope=SCOPE] [--idempotency-key=KEY]`,
      `  ${CLI_BIN} webhook create <url> [--event=EVENT[,EVENT2,...]] [--idempotency-key=KEY]`,
      `  ${CLI_BIN} webhook verify --secret=S --signature=H --timestamp=T [--body=PATH] [--tolerance-seconds=N]`,
      `  ${CLI_BIN} webhook sign --secret=S --timestamp=T [--body=PATH]`,
      `  ${CLI_BIN} webhook secrets rotate <endpointId> [--idempotency-key=KEY]`,
      `  ${CLI_BIN} webhook enable <endpointId> [--idempotency-key=KEY] [--output=human|json]`,
      `  ${CLI_BIN} webhook disable <endpointId> [--reason=TEXT] [--idempotency-key=KEY] [--output=human|json]`,
      `  ${CLI_BIN} webhook deliveries <endpointId> [--limit=N] [--cursor=CURSOR] [--all] [--output=human|json]`,
      `  ${CLI_BIN} webhook deliveries replay <attemptId> [--idempotency-key=KEY] [--output=human|json]`,
      "",
      "USAGE / BILLING / AUDIT:",
      `  ${CLI_BIN} usage summary [--metric=METRIC] [--from=ISO] [--to=ISO]`,
      `  ${CLI_BIN} billing summary`,
      `  ${CLI_BIN} audit list [--limit=N] [--cursor=CURSOR] [--category=CAT] [--all]`,
      "                         [--actor=ID] [--actor-type=TYPE] [--subject-kind=KIND]",
      "                         [--subject-id=ID] [--event-type=TYPE] [--from=ISO] [--to=ISO]",
      "                         [--format=ndjson]",
      "",
      "SECURITY:",
      `  ${CLI_BIN} security events [--limit=N] [--cursor=CURSOR] [--all] [--output=human|json]`,
      "",
      "GLOBAL FLAGS:",
      "  --output=human|json   Output format (default: human)",
      "  --help                Show this help",
      "  --version             Print version",
      "",
      "IDEMPOTENCY:",
      "  --idempotency-key=KEY is forwarded verbatim to the API on every write.",
      "  The CLI never auto-generates a key (Stripe parity).",
    ].join("\n"),
  );
}

function printUsageHint(stderr: (line: string) => void): void {
  stderr(`run \`${CLI_BIN} --help\` to see available commands`);
}

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}
function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}
