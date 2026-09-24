// `meterwise login` — token-paste auth flow.
//
// Rationale (recorded in the implementer report's auth-flow choice):
//   The api-edge currently exposes `/v1/auth/login/{start,complete}` for
//   the WEB session (browser cookie) flow but no device-grant endpoint
//   that issues a CLI bearer token. Spec 13's `login` command is
//   under-specified on the wire format, and adding a new server route is
//   out-of-scope for this PR. We ship the token-paste flow today: the
//   user pastes a Bearer token (e.g. an API-key, or a session-token they
//   copy out of the console), the CLI validates by calling
//   `client.organizations.list()`, and stores the credential on success.
//
//   When the CLI later gains a device-flow endpoint, switching is a
//   one-line dispatch in this file.

import { Meterwise } from "@saas/sdk";

import type { OutputMode } from "../output/index.js";
import { formatOutput } from "../output/index.js";
import type { ContextStore } from "../context/store.js";
import type { TokenStore } from "../token-store/types.js";
import { DEFAULT_API_URL } from "../brand.js";

export interface LoginInput {
  readonly apiUrl?: string;
  readonly token?: string;
  readonly outputMode: OutputMode;
  readonly tokenStore: TokenStore;
  readonly contextStore: ContextStore;
  readonly readToken: () => Promise<string>;
  readonly stdout: (line: string) => void;
  /** SDK factory override (tests). */
  readonly sdkFactory?: (baseUrl: string, token: string) => Meterwise;
}

export interface LoginOutcome {
  readonly apiUrl: string;
  readonly orgCount: number;
}

export async function loginFlow(input: LoginInput): Promise<LoginOutcome> {
  const apiUrl = (input.apiUrl ?? DEFAULT_API_URL).trim();
  if (apiUrl.length === 0) {
    throw new Error("--api-url cannot be empty");
  }

  let token = input.token;
  if (token === undefined || token.length === 0) {
    if (input.outputMode !== "json") {
      input.stdout(`Logging in to ${apiUrl}`);
      input.stdout("Paste a Bearer token (input is not echoed):");
    }
    token = (await input.readToken()).trim();
  }
  if (token.length === 0) {
    throw new Error("token cannot be empty");
  }

  // Validate by calling the SDK. Auth failures throw
  // `UnauthenticatedError`; the caller's error handler turns that into a
  // friendly "token rejected" message.
  const client =
    input.sdkFactory?.(apiUrl, token) ??
    new Meterwise({ baseUrl: apiUrl, auth: { kind: "bearer", token } });
  const result = await client.organizations.list();
  const orgCount = result.organizations.length;

  await input.tokenStore.save({ apiUrl, token });
  await input.contextStore.setLastApiUrl(apiUrl);

  if (input.outputMode === "human") {
    input.stdout(
      formatOutput({
        mode: "human",
        title: "✓ Authenticated",
        record: { apiUrl, organizations: String(orgCount) },
      }),
    );
  } else {
    input.stdout(
      formatOutput({
        mode: "json",
        data: { apiUrl, organizations: orgCount },
      }),
    );
  }

  return { apiUrl, orgCount };
}

export const LOGIN_DEFAULT_API_URL = DEFAULT_API_URL;
