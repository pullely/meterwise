import { route } from "@policy-worker/router";
import type { Env } from "@policy-worker/env";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const env: Env = { ENVIRONMENT: "test" };

function makeRequest(method: string, url: string, body?: unknown, headers?: Record<string, string>): Request {
  const init: RequestInit = { method, headers: headers ?? {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  return new Request(url, init);
}

type JsonResp = {
  service: string;
  environment: string;
  policyVersion: number;
  status: string;
  timestamp: string;
  data: {
    allow: boolean;
    reason: string;
    policyVersion: number;
    permissions: string[];
    valid: boolean;
  };
  error: {
    code: string;
    message: string;
    requestId: string;
    details: { fields: Record<string, unknown> };
  };
  meta: { requestId: string };
};

async function json(response: Response): Promise<JsonResp> {
  return (await response.json()) as JsonResp;
}

describe("policy-worker routes", () => {
  describe("GET /health", () => {
    it("returns health response with service name and policyVersion", async () => {
      const req = makeRequest("GET", "http://localhost/health");
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body.service).toBe("policy-worker");
      expect(body.environment).toBe("test");
      expect(body.policyVersion).toBe(1);
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });

    it("includes x-request-id header", async () => {
      const req = makeRequest("GET", "http://localhost/health");
      const res = await route(req, env);
      expect(res.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{24}$/);
    });
  });

  describe("POST /v1/internal/policy/authorize", () => {
    const validBody = {
      subject: { type: "user", id: "usr_123" },
      action: "organization.read",
      resource: { kind: "organization", orgId: "org_1" },
      context: {
        memberships: [
          { kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: "org_1" } },
        ],
      },
    };

    it("returns success envelope with allow: true", async () => {
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", validBody);
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body.data.allow).toBe(true);
      expect(body.data.reason).toBe("org_owner");
      expect(body.data.policyVersion).toBe(1);
      expect(body.meta.requestId).toMatch(/^req_/);
    });

    it("returns HTTP 200 with allow: false for denied authorization", async () => {
      const deniedBody = {
        ...validBody,
        context: { memberships: [] },
      };
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", deniedBody);
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body.data.allow).toBe(false);
      expect(body.data.reason).toBe("no_matching_role");
    });

    it("returns error for malformed JSON", async () => {
      const req = new Request("http://localhost/v1/internal/policy/authorize", {
        method: "POST",
        body: "not-json{{{",
        headers: { "content-type": "application/json" },
      });
      const res = await route(req, env);
      expect(res.status).toBe(400);

      const body = await json(res);
      expect(body.error.code).toBe("bad_request");
      expect(body.error.message).toBe("Invalid JSON body");
      expect(body.error.requestId).toMatch(/^req_/);
    });

    it("returns validation_failed for missing required fields", async () => {
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", { foo: "bar" });
      const res = await route(req, env);
      expect(res.status).toBe(422);

      const body = await json(res);
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details.fields).toBeDefined();
      expect(body.error.details.fields.subject).toBeDefined();
      expect(body.error.details.fields.action).toBeDefined();
      expect(body.error.details.fields.resource).toBeDefined();
      expect(body.error.details.fields.context).toBeDefined();
    });

    it("returns validation_failed for invalid core field types", async () => {
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", {
        ...validBody,
        subject: { type: "robot", id: "usr_123" },
        resource: { kind: "project", orgId: "org_1", projectId: 123 },
      });
      const res = await route(req, env);
      expect(res.status).toBe(422);

      const body = await json(res);
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details.fields["subject.type"]).toBeDefined();
      expect(body.error.details.fields["resource.projectId"]).toBeDefined();
    });

    it("ignores unknown future membership facts without widening access", async () => {
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", {
        ...validBody,
        context: { memberships: [{ kind: "quota", limit: 100 }] },
      });
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body.data.allow).toBe(false);
      expect(body.data.reason).toBe("no_matching_role");
    });

    it("does not expose stack traces in error responses", async () => {
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", { foo: "bar" });
      const res = await route(req, env);
      const body = await json(res);
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toContain("at ");
      expect(bodyStr).not.toContain("Error:");
      expect(bodyStr).not.toContain("stack");
    });
  });

  describe("POST /v1/internal/policy/effective-permissions", () => {
    it("returns effective permissions for a subject", async () => {
      const body = {
        subject: { type: "user", id: "usr_123" },
        resource: { kind: "organization", orgId: "org_1" },
        context: {
          memberships: [
            { kind: "role_assignment", role: "viewer", scope: { kind: "organization", orgId: "org_1" } },
          ],
        },
      };
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/effective-permissions", body);
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const result = await json(res);
      expect(result.data.policyVersion).toBe(1);
      expect(Array.isArray(result.data.permissions)).toBe(true);
      expect(result.data.permissions.length).toBeGreaterThan(0);
    });
  });

  describe("POST /v1/internal/policy/role-assignments/validate", () => {
    it("returns valid for correct org role assignment", async () => {
      const body = {
        role: "admin",
        scope: { kind: "organization", orgId: "org_1" },
      };
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/role-assignments/validate", body);
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const result = await json(res);
      expect(result.data.valid).toBe(true);
      expect(result.data.reason).toBe("valid_org_role");
    });

    it("returns invalid for bad role assignment", async () => {
      const body = {
        role: "project_admin",
        scope: { kind: "organization", orgId: "org_1" },
      };
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/role-assignments/validate", body);
      const res = await route(req, env);
      expect(res.status).toBe(200);

      const result = await json(res);
      expect(result.data.valid).toBe(false);
      expect(result.data.reason).toBe("invalid_role_for_scope");
    });

    it("returns validation_failed for invalid projectId field type", async () => {
      const body = {
        role: "project_admin",
        scope: { kind: "project", orgId: "org_1", projectId: 123 },
      };
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/role-assignments/validate", body);
      const res = await route(req, env);
      expect(res.status).toBe(422);

      const result = await json(res);
      expect(result.error.code).toBe("validation_failed");
      expect(result.error.details.fields["scope.projectId"]).toBeDefined();
    });
  });

  describe("request ID handling", () => {
    it("preserves valid x-request-id from caller", async () => {
      const req = makeRequest("GET", "http://localhost/health", undefined, {
        "x-request-id": "my-custom-id-123",
      });
      const res = await route(req, env);
      await json(res);
      expect(res.headers.get("x-request-id")).toBe("my-custom-id-123");
    });

    it("generates request ID when header is missing", async () => {
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", {
        subject: { type: "user", id: "usr_1" },
        action: "organization.read",
        resource: { kind: "organization", orgId: "org_1" },
        context: { memberships: [] },
      });
      const res = await route(req, env);
      const body = await json(res);
      expect(body.meta.requestId).toMatch(/^req_[0-9a-f]{24}$/);
    });

    it("generates request ID when header is invalid", async () => {
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", {
        subject: { type: "user", id: "usr_1" },
        action: "organization.read",
        resource: { kind: "organization", orgId: "org_1" },
        context: { memberships: [] },
      }, { "x-request-id": "has spaces not ok" });
      const res = await route(req, env);
      const body = await json(res);
      expect(body.meta.requestId).toMatch(/^req_[0-9a-f]{24}$/);
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const req = makeRequest("GET", "http://localhost/unknown");
      const res = await route(req, env);
      expect(res.status).toBe(404);

      const body = await json(res);
      expect(body.error.code).toBe("not_found");
    });
  });

  describe("safe error responses", () => {
    it("does not contain connection strings or tokens", async () => {
      const req = makeRequest("POST", "http://localhost/v1/internal/policy/authorize", "invalid");
      const res = await route(req, env);
      const body = await json(res);
      const str = JSON.stringify(body);
      expect(str).not.toContain("postgres://");
      expect(str).not.toContain("Bearer ");
      expect(str).not.toContain("sps_ses_");
      expect(str).not.toContain("password");
    });
  });
});

describe("wrangler.jsonc configuration", () => {
  const wranglerPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../apps/policy-worker/wrangler.jsonc",
  );

  it("has workers_dev: false for stage", () => {
    const content = fs.readFileSync(wranglerPath, "utf-8");
    const stageSection = content.indexOf('"stage"');
    const afterStage = content.slice(stageSection);
    expect(afterStage).toContain('"workers_dev": false');
  });

  it("has workers_dev: false for prod", () => {
    const content = fs.readFileSync(wranglerPath, "utf-8");
    const prodSection = content.indexOf('"prod"');
    const afterProd = content.slice(prodSection);
    expect(afterProd).toContain('"workers_dev": false');
  });
});
