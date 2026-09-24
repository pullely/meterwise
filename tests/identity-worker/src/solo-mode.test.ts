import type { Env } from "../../../apps/identity-worker/src/env";
import {
  isSoloMode,
  personalOrgName,
  personalOrgSlug,
  ensurePersonalOrg,
} from "../../../apps/identity-worker/src/solo-mode";

// A minimal Fetcher shape — we deliberately avoid the ambient `Fetcher` global
// so this file type-checks whether run alone or as part of the full suite.
interface FetcherLike {
  fetch(input: string | Request | URL, init?: RequestInit): Promise<Response>;
  connect?: unknown;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function recordingFetcher(
  responder: (url: string, init: RequestInit) => Response,
): { fetcher: FetcherLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: FetcherLike = {
    fetch(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(responder(url, init ?? {}));
    },
  };
  return { fetcher, calls };
}

function envWith(fetcher: FetcherLike | undefined, solo: boolean): Env {
  return {
    ...(solo ? { SOLO_MODE: "true" } : {}),
    ...(fetcher ? { MEMBERSHIP_WORKER: fetcher } : {}),
  } as unknown as Env;
}

function listResponse(orgs: unknown[]): Response {
  return Response.json({ data: { organizations: orgs }, meta: { requestId: "r", cursor: null } });
}

const USER = { id: "usr_abc123", email: "ada@example.com", displayName: "Ada Lovelace" };

describe("isSoloMode", () => {
  it('is true only for "true"', () => {
    expect(isSoloMode({ SOLO_MODE: "true" } as Env)).toBe(true);
    expect(isSoloMode({} as Env)).toBe(false);
    expect(isSoloMode({ SOLO_MODE: "false" } as Env)).toBe(false);
  });
});

describe("personalOrgName", () => {
  it("prefers display name, falls back to email local-part, then 'Personal'", () => {
    expect(personalOrgName(USER)).toBe("Ada Lovelace");
    expect(personalOrgName({ id: "u", email: "ada@example.com" })).toBe("ada");
    expect(personalOrgName({ id: "u", email: "ada@example.com", displayName: "  " })).toBe("ada");
    expect(personalOrgName({ id: "u", email: "@nolocal" })).toBe("Personal");
  });
  it("caps at 100 chars", () => {
    const long = "x".repeat(200);
    expect(personalOrgName({ id: "u", email: "e@e.com", displayName: long }).length).toBe(100);
  });
});

describe("personalOrgSlug", () => {
  it("is deterministic, prefixed, and slug-rule valid", () => {
    const slug = personalOrgSlug("usr_abc123");
    expect(slug).toBe("personal-usr-abc123");
    expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(personalOrgSlug("usr_abc123")).toBe(slug); // stable
  });
  it("never ends in a hyphen even after truncation", () => {
    const slug = personalOrgSlug("USR_" + "A".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });
});

describe("ensurePersonalOrg", () => {
  it("is a no-op when SOLO_MODE is off", async () => {
    const { fetcher, calls } = recordingFetcher(() => listResponse([]));
    await ensurePersonalOrg(envWith(fetcher, false), "req_1", USER);
    expect(calls).toHaveLength(0);
  });

  it("is a no-op (no throw) when there is no membership binding", async () => {
    await expect(ensurePersonalOrg(envWith(undefined, true), "req_1", USER)).resolves.toBeUndefined();
  });

  it("creates the personal org when the user has none", async () => {
    const { fetcher, calls } = recordingFetcher(() => listResponse([]));
    await ensurePersonalOrg(envWith(fetcher, true), "req_42", USER);

    expect(calls).toHaveLength(2);
    const list = calls[0]!;
    const create = calls[1]!;
    expect(list.method).toBe("GET");
    expect(create.method).toBe("POST");
    expect(create.url).toBe("https://membership.internal/v1/organizations");
    expect(create.headers["x-actor-subject-id"]).toBe(USER.id);
    expect(create.headers["x-actor-subject-type"]).toBe("user");
    expect(create.headers["x-actor-email"]).toBe(USER.email);
    expect(create.body).toEqual({ name: "Ada Lovelace", slug: "personal-usr-abc123" });
  });

  it("is idempotent: does NOT create when the user already owns an org", async () => {
    const { fetcher, calls } = recordingFetcher(() =>
      listResponse([{ id: "org_1", slug: "personal-usr-abc123" }]),
    );
    await ensurePersonalOrg(envWith(fetcher, true), "req_7", USER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
  });

  it("never throws when the membership service errors (best-effort)", async () => {
    const fetcher: FetcherLike = {
      fetch: () => Promise.reject(new Error("connection refused")),
    };
    await expect(ensurePersonalOrg(envWith(fetcher, true), "req_9", USER)).resolves.toBeUndefined();
  });
});
