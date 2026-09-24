// Console-side glue for `@saas/sdk` (Task 0104).
//
// The hand-rolled fetch/decode/envelope client that used to live here was
// deleted; all wire I/O now goes through the typed `Meterwise` resource
// clients in `@saas/sdk`. This file keeps only what is intrinsically a
// console concern:
//
//   - `ApiTarget` / `TARGETS` / `DEPLOY_ENV` / `IS_LOCKED` — the multi-target
//     switcher the console exposes for stage/prod parity testing. The SDK
//     deliberately doesn't carry "which environment am I pointed at",
//     because that's a deployment-shape decision.
//   - `createClient` — constructs a `Meterwise` against a target, wired
//     to a bearer token (or none).
//   - `ApiResult<T>` / `ApiErrorBody` / `wrap` — the result-envelope shape
//     `useAsync` and the precondition-failed UX consume. `wrap` adapts a
//     `Promise<T>` + thrown `MeterwiseError` into the same shape the
//     old hand-rolled client produced, so call-site ergonomics are
//     unchanged. NO route strings, NO header building, NO JSON decoding
//     happens here — that all comes from the SDK.

import { Meterwise, MeterwiseError, type ClientOptions } from "@saas/sdk";
import { apiEdgeWorkersDevUrl } from "./app-config";

export type ApiClient = Meterwise;

export interface ApiTarget {
  name: string;
  url: string;
}

const ALL_TARGETS: ApiTarget[] = [
  { name: "stage", url: apiEdgeWorkersDevUrl("stage") },
  { name: "prod", url: apiEdgeWorkersDevUrl("prod") },
];

export const DEPLOY_ENV: string | undefined =
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_DEPLOY_ENV || undefined : undefined;

export const TARGETS: ApiTarget[] = DEPLOY_ENV
  ? ALL_TARGETS.filter((t) => t.name === DEPLOY_ENV)
  : ALL_TARGETS;

export const IS_LOCKED: boolean = TARGETS.length === 1 && !!DEPLOY_ENV;

export interface ApiErrorBody {
  code: string;
  message: string;
  reason?: string | undefined;
  details?: Record<string, unknown> | undefined;
  requestId?: string | undefined;
}

export type ApiResult<T> =
  | { ok: true; data: T; meta: { requestId: string; cursor: string | null } }
  | { ok: false; error: ApiErrorBody; status: number };

export function createClient(target: ApiTarget, token: string | null): Meterwise {
  const opts: ClientOptions = { baseUrl: target.url };
  if (token) opts.auth = { kind: "bearer", token };
  return new Meterwise(opts);
}

/**
 * Adapt an SDK promise into the `ApiResult<T>` envelope. Typed
 * `MeterwiseError` subclasses surface as `{ ok: false }` carrying the
 * same `code`/`message`/`reason`/`details`/`requestId` fields the
 * precondition-failed insight UX depends on. Network errors collapse to
 * `code: "network_error"` to match the old shape.
 */
export async function wrap<T>(fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data, meta: { requestId: "", cursor: null } };
  } catch (e) {
    if (e instanceof MeterwiseError) {
      const body: ApiErrorBody = {
        code: e.code,
        message: e.message,
        details: e.details,
        requestId: e.requestId,
      };
      const reason = e.details["reason"];
      if (typeof reason === "string") body.reason = reason;
      return { ok: false, status: e.status, error: body };
    }
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: (e as Error).message ?? "network unreachable",
      },
    };
  }
}
