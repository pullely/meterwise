import type {
  LoginCompleteRequest,
  LoginCompleteResponse,
  LoginStartRequest,
  LoginStartResponse,
  LogoutResponse,
  OAuthProvidersResponse,
  ProfileResponse,
  SessionResponse,
  UpdateProfileRequest,
} from "@saas/contracts/auth";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Auth resource client (Task 0103).
 *
 * Wraps the identity-worker public auth surface exposed by the api-edge
 * `auth-facade` route table:
 *   - POST   /v1/auth/login/start
 *   - POST   /v1/auth/login/complete
 *   - GET    /v1/auth/session
 *   - POST   /v1/auth/logout
 *   - GET    /v1/auth/profile
 *   - PATCH  /v1/auth/profile
 *
 * Stripe parity: `loginStart`, `loginComplete`, and `logout` are POSTs that
 * accept a caller-owned `idempotencyKey` via `RequestOptions`. The SDK MUST
 * NOT auto-generate one — it is forwarded verbatim if present, omitted
 * otherwise.
 *
 * Note: `/v1/auth/resolve` is intentionally NOT exposed — that endpoint is
 * internal to service-binding bearer resolution. `/v1/auth/security-events`
 * is also out of scope here; it lives on `SecurityEventsClient` (Task 0099).
 */
export class AuthClient {
  constructor(private readonly transport: Transport) {}

  /** POST /v1/auth/login/start */
  loginStart(
    input: LoginStartRequest,
    opts: RequestOptions = {},
  ): Promise<LoginStartResponse> {
    return this.transport.request<LoginStartResponse>(
      {
        method: "POST",
        path: "/v1/auth/login/start",
        body: input,
      },
      opts,
    );
  }

  /** POST /v1/auth/login/complete */
  loginComplete(
    input: LoginCompleteRequest,
    opts: RequestOptions = {},
  ): Promise<LoginCompleteResponse> {
    return this.transport.request<LoginCompleteResponse>(
      {
        method: "POST",
        path: "/v1/auth/login/complete",
        body: input,
      },
      opts,
    );
  }

  /** GET /v1/auth/oauth/providers — the configured OAuth sign-in providers. */
  listOAuthProviders(opts: RequestOptions = {}): Promise<OAuthProvidersResponse> {
    return this.transport.request<OAuthProvidersResponse>(
      {
        method: "GET",
        path: "/v1/auth/oauth/providers",
      },
      opts,
    );
  }

  /**
   * Build the absolute URL that begins an OAuth login. This is NOT an XHR
   * endpoint — assign it to `window.location` so the provider redirect and the
   * state-cookie handshake run as top-level browser navigations.
   *
   * @param providerId provider id from {@link listOAuthProviders} (e.g. "github")
   * @param returnTo   absolute URL the user is returned to after sign-in
   *                   (must be an allow-listed console origin server-side)
   */
  oauthStartUrl(providerId: string, returnTo: string): string {
    const url = new URL(
      `${this.transport.baseUrl}/v1/auth/oauth/${encodeURIComponent(providerId)}/start`,
    );
    url.searchParams.set("return_to", returnTo);
    return url.toString();
  }

  /** GET /v1/auth/session */
  getSession(opts: RequestOptions = {}): Promise<SessionResponse> {
    return this.transport.request<SessionResponse>(
      {
        method: "GET",
        path: "/v1/auth/session",
      },
      opts,
    );
  }

  /** POST /v1/auth/logout */
  logout(opts: RequestOptions = {}): Promise<LogoutResponse> {
    return this.transport.request<LogoutResponse>(
      {
        method: "POST",
        path: "/v1/auth/logout",
      },
      opts,
    );
  }

  /** GET /v1/auth/profile */
  getProfile(opts: RequestOptions = {}): Promise<ProfileResponse> {
    return this.transport.request<ProfileResponse>(
      {
        method: "GET",
        path: "/v1/auth/profile",
      },
      opts,
    );
  }

  /** PATCH /v1/auth/profile */
  updateProfile(
    input: UpdateProfileRequest,
    opts: RequestOptions = {},
  ): Promise<ProfileResponse> {
    return this.transport.request<ProfileResponse>(
      {
        method: "PATCH",
        path: "/v1/auth/profile",
        body: input,
      },
      opts,
    );
  }
}
