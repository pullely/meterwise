import { route } from "@integrations-worker/router";
import type { Env } from "@integrations-worker/env";

function createFakeEnv(overrides?: Partial<Record<keyof Env, unknown>>): Env {
  const base: Record<string, unknown> = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
  };
  return { ...base, ...overrides } as unknown as Env;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("integrations-worker router (IG0 — dormant)", () => {
  it("responds 200 on /health with service identity and check map", async () => {
    const response = await route(new Request("https://worker.test/health"), createFakeEnv());
    expect(response.status).toBe(200);

    const body = await json(response);
    const data = body.data as Record<string, unknown>;
    expect(data.service).toBe("integrations-worker");
    expect(data.environment).toBe("test");

    const checks = data.checks as Record<string, { configured: boolean }>;
    expect(checks.database!.configured).toBe(true);
    expect(checks.membership!.configured).toBe(false);
    expect(checks.policy!.configured).toBe(false);
    expect(checks.billing!.configured).toBe(false);
    expect(checks.githubApp!.configured).toBe(false);
  });

  it("reports githubApp configured only when the full App secret set is present", async () => {
    const partial = createFakeEnv({ GITHUB_APP_ID: "12345" });
    const partialBody = await json(await route(new Request("https://worker.test/health"), partial));
    const partialChecks = (partialBody.data as Record<string, unknown>).checks as Record<
      string,
      { configured: boolean }
    >;
    expect(partialChecks.githubApp!.configured).toBe(false);

    const full = createFakeEnv({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
      GITHUB_APP_WEBHOOK_SECRET: "whsec",
    });
    const fullBody = await json(await route(new Request("https://worker.test/health"), full));
    const fullChecks = (fullBody.data as Record<string, unknown>).checks as Record<
      string,
      { configured: boolean }
    >;
    expect(fullChecks.githubApp!.configured).toBe(true);
  });

  it("never exposes secret values through /health", async () => {
    const env = createFakeEnv({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "super-secret-pem",
      GITHUB_APP_WEBHOOK_SECRET: "super-secret-hmac",
    });
    const response = await route(new Request("https://worker.test/health"), env);
    const raw = JSON.stringify(await json(response));
    expect(raw).not.toContain("super-secret-pem");
    expect(raw).not.toContain("super-secret-hmac");
    expect(raw).not.toContain("12345");
  });

  it("returns 404 for unknown routes presented by an authenticated caller", async () => {
    const env = createFakeEnv({
      MEMBERSHIP_WORKER: {} as unknown,
      POLICY_WORKER: {} as unknown,
    });
    const paths = ["/", "/ingress/github/unknown", "/v1/unknown"];
    for (const path of paths) {
      const response = await route(
        new Request(`https://worker.test${path}`, {
          headers: { "x-actor-subject-id": "usr_a", "x-actor-subject-type": "user" },
        }),
        env,
      );
      expect(response.status).toBe(404);
      const body = await json(response);
      expect((body.error as Record<string, unknown>).code).toBe("not_found");
    }
  });

  it("requires an actor on the org integrations surface", async () => {
    const env = createFakeEnv({
      MEMBERSHIP_WORKER: {} as unknown,
      POLICY_WORKER: {} as unknown,
    });
    const response = await route(
      new Request(
        "https://worker.test/v1/organizations/org_11111111111111111111111111111111/integrations",
      ),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("echoes a well-formed x-request-id and generates one otherwise", async () => {
    const env = createFakeEnv();
    const echoed = await route(
      new Request("https://worker.test/health", { headers: { "x-request-id": "req_abc123" } }),
      env,
    );
    expect(((await json(echoed)).meta as Record<string, unknown>).requestId).toBe("req_abc123");

    const generated = await route(new Request("https://worker.test/health"), env);
    const requestId = ((await json(generated)).meta as Record<string, unknown>).requestId as string;
    expect(requestId).toMatch(/^req_[0-9a-f]{24}$/);
  });
});
