import { handlePreflight, applyCorsHeaders, isAllowedOrigin } from "@api-edge/cors";
import { consoleWorkersDevOrigin } from "@api-edge/app-config";
import type { Env } from "@api-edge/env";

const stageEnv: Env = { ENVIRONMENT: "stage", CONSOLE_CUSTOM_DOMAIN: "stage.meterwise.app" };
const prodEnv: Env = { ENVIRONMENT: "prod", CONSOLE_CUSTOM_DOMAIN: "prod.meterwise.app" };
const testEnv: Env = { ENVIRONMENT: "test" };

// Post Task 0083: legacy `apps/web-console` (Pages) was decommissioned. The CORS
// allowlist now permits only the custom-domain hostnames + the web-console-next
// `*.workers.dev` shadow hostnames. Origins are built from the same BF3
// identity seam the worker uses (`app-config`), so the assertions exercise the
// allowlist *logic*, not a copy of the literals.
const STAGE_WORKER_ORIGIN = consoleWorkersDevOrigin("stage");
const PROD_WORKER_ORIGIN = consoleWorkersDevOrigin("prod");
const DEV_WORKER_ORIGIN = consoleWorkersDevOrigin("dev");

describe("api-edge cors", () => {
  describe("isAllowedOrigin — stage environment", () => {
    it("allows the stage custom domain origin", () => {
      expect(isAllowedOrigin("https://stage.meterwise.app", stageEnv)).toBe(true);
    });

    it("allows the stage workers.dev origin", () => {
      expect(isAllowedOrigin(STAGE_WORKER_ORIGIN, stageEnv)).toBe(true);
    });

    it("rejects the prod custom domain origin", () => {
      expect(isAllowedOrigin("https://prod.meterwise.app", stageEnv)).toBe(false);
    });

    it("rejects the prod workers.dev origin", () => {
      expect(isAllowedOrigin(PROD_WORKER_ORIGIN, stageEnv)).toBe(false);
    });

    it("rejects the legacy Pages console origins", () => {
      expect(isAllowedOrigin("https://meterwise-web-console.pages.dev", stageEnv)).toBe(false);
      expect(isAllowedOrigin("https://meterwise-web-console-stage.pages.dev", stageEnv)).toBe(false);
      expect(isAllowedOrigin("https://meterwise-web-console-prod.pages.dev", stageEnv)).toBe(false);
      expect(isAllowedOrigin("https://abc123.meterwise-web-console-stage.pages.dev", stageEnv)).toBe(false);
    });

    it("allows localhost origins", () => {
      expect(isAllowedOrigin("http://localhost:5173", stageEnv)).toBe(true);
      expect(isAllowedOrigin("http://localhost:3000", stageEnv)).toBe(true);
      expect(isAllowedOrigin("https://localhost", stageEnv)).toBe(true);
    });

    it("allows 127.0.0.1 origins", () => {
      expect(isAllowedOrigin("http://127.0.0.1:5173", stageEnv)).toBe(true);
    });
  });

  describe("isAllowedOrigin — prod environment", () => {
    it("allows the prod custom domain origin", () => {
      expect(isAllowedOrigin("https://prod.meterwise.app", prodEnv)).toBe(true);
    });

    it("allows the prod workers.dev origin", () => {
      expect(isAllowedOrigin(PROD_WORKER_ORIGIN, prodEnv)).toBe(true);
    });

    it("rejects the stage custom domain origin", () => {
      expect(isAllowedOrigin("https://stage.meterwise.app", prodEnv)).toBe(false);
    });

    it("rejects the stage workers.dev origin", () => {
      expect(isAllowedOrigin(STAGE_WORKER_ORIGIN, prodEnv)).toBe(false);
    });

    it("rejects the legacy Pages console origins", () => {
      expect(isAllowedOrigin("https://meterwise-web-console.pages.dev", prodEnv)).toBe(false);
      expect(isAllowedOrigin("https://meterwise-web-console-prod.pages.dev", prodEnv)).toBe(false);
      expect(isAllowedOrigin("https://feat-branch-42.meterwise-web-console-stage.pages.dev", prodEnv)).toBe(false);
    });

    it("allows localhost origins", () => {
      expect(isAllowedOrigin("http://localhost:5173", prodEnv)).toBe(true);
    });

    it("allows 127.0.0.1 origins", () => {
      expect(isAllowedOrigin("http://127.0.0.1:5173", prodEnv)).toBe(true);
    });
  });

  describe("isAllowedOrigin — fallback (test/unknown environment)", () => {
    it("rejects custom domain origins when CONSOLE_CUSTOM_DOMAIN is not set", () => {
      expect(isAllowedOrigin("https://stage.meterwise.app", testEnv)).toBe(false);
      expect(isAllowedOrigin("https://prod.meterwise.app", testEnv)).toBe(false);
    });

    it("allows custom domain origin when CONSOLE_CUSTOM_DOMAIN is set", () => {
      const envWithDomain: Env = { ENVIRONMENT: "test", CONSOLE_CUSTOM_DOMAIN: "custom.example.com" };
      expect(isAllowedOrigin("https://custom.example.com", envWithDomain)).toBe(true);
    });

    it("allows all workers.dev origins (dev, stage, prod) in fallback env", () => {
      expect(isAllowedOrigin(DEV_WORKER_ORIGIN, testEnv)).toBe(true);
      expect(isAllowedOrigin(STAGE_WORKER_ORIGIN, testEnv)).toBe(true);
      expect(isAllowedOrigin(PROD_WORKER_ORIGIN, testEnv)).toBe(true);
    });

    it("rejects legacy Pages console origins in fallback env", () => {
      expect(isAllowedOrigin("https://meterwise-web-console-stage.pages.dev", testEnv)).toBe(false);
      expect(isAllowedOrigin("https://meterwise-web-console-prod.pages.dev", testEnv)).toBe(false);
    });

    it("allows localhost origins", () => {
      expect(isAllowedOrigin("http://localhost:5173", testEnv)).toBe(true);
    });
  });

  describe("isAllowedOrigin — common rejections", () => {
    it("rejects null origin", () => {
      expect(isAllowedOrigin(null, stageEnv)).toBe(false);
      expect(isAllowedOrigin(null, prodEnv)).toBe(false);
    });

    it("rejects arbitrary origins", () => {
      expect(isAllowedOrigin("https://evil.com", stageEnv)).toBe(false);
      expect(isAllowedOrigin("https://evil.com", prodEnv)).toBe(false);
      expect(
        // Suffix attack: the real stage origin with `.evil.com` appended must
        // stay disallowed. Derived from the seam so the attack string tracks
        // the real hostname.
        isAllowedOrigin(`${consoleWorkersDevOrigin("stage")}.evil.com`, stageEnv),
      ).toBe(false);
    });

    it("rejects similar but not matching origins", () => {
      expect(isAllowedOrigin("https://other-project.workers.dev", stageEnv)).toBe(false);
      expect(isAllowedOrigin(`${STAGE_WORKER_ORIGIN}:8080`, stageEnv)).toBe(false);
    });
  });

  describe("handlePreflight", () => {
    it("returns null for non-OPTIONS requests", () => {
      const req = new Request("https://api.test/v1/auth/session", { method: "GET" });
      expect(handlePreflight(req, stageEnv)).toBeNull();
    });

    it("returns 204 with CORS headers for allowed stage custom domain", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        method: "OPTIONS",
        headers: { origin: "https://stage.meterwise.app" },
      });
      const res = handlePreflight(req, stageEnv);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(204);
      expect(res!.headers.get("access-control-allow-origin")).toBe(
        "https://stage.meterwise.app",
      );
      expect(res!.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it("returns 204 with CORS headers for allowed stage workers.dev origin", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        method: "OPTIONS",
        headers: { origin: STAGE_WORKER_ORIGIN },
      });
      const res = handlePreflight(req, stageEnv);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(204);
      expect(res!.headers.get("access-control-allow-origin")).toBe(STAGE_WORKER_ORIGIN);
      expect(res!.headers.get("access-control-allow-methods")).toContain("GET");
      expect(res!.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res!.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(res!.headers.get("access-control-allow-headers")).toContain("content-type");
      expect(res!.headers.get("access-control-allow-headers")).toContain("x-request-id");
      expect(res!.headers.get("access-control-allow-headers")).toContain("traceparent");
      expect(res!.headers.get("access-control-allow-headers")).toContain("idempotency-key");
      expect(res!.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res!.headers.get("vary")).toBe("Origin");
    });

    it("returns 204 without CORS headers when prod custom domain hits stage API", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        method: "OPTIONS",
        headers: { origin: "https://prod.meterwise.app" },
      });
      const res = handlePreflight(req, stageEnv);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(204);
      expect(res!.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("returns 204 without CORS headers when prod workers.dev hits stage API", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        method: "OPTIONS",
        headers: { origin: PROD_WORKER_ORIGIN },
      });
      const res = handlePreflight(req, stageEnv);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(204);
      expect(res!.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("returns 204 without CORS headers for disallowed origin", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        method: "OPTIONS",
        headers: { origin: "https://evil.com" },
      });
      const res = handlePreflight(req, stageEnv);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(204);
      expect(res!.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("returns 204 without CORS headers when no origin", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        method: "OPTIONS",
      });
      const res = handlePreflight(req, prodEnv);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(204);
      expect(res!.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("applyCorsHeaders", () => {
    it("adds CORS headers for stage custom domain on stage env", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        headers: { origin: "https://stage.meterwise.app" },
      });
      const original = Response.json({ data: {} }, { status: 200 });
      const res = applyCorsHeaders(original, req, stageEnv);

      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://stage.meterwise.app",
      );
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("vary")).toBe("Origin");
    });

    it("adds CORS headers for allowed stage workers.dev origin on stage env", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        headers: { origin: STAGE_WORKER_ORIGIN },
      });
      const original = Response.json({ data: {} }, { status: 200 });
      const res = applyCorsHeaders(original, req, stageEnv);

      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(STAGE_WORKER_ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("vary")).toBe("Origin");
    });

    it("does not add CORS headers for prod custom domain on stage env", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        headers: { origin: "https://prod.meterwise.app" },
      });
      const original = Response.json({ data: {} }, { status: 200 });
      const res = applyCorsHeaders(original, req, stageEnv);

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("does not add CORS headers for prod workers.dev origin on stage env", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        headers: { origin: PROD_WORKER_ORIGIN },
      });
      const original = Response.json({ data: {} }, { status: 200 });
      const res = applyCorsHeaders(original, req, stageEnv);

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("does not add CORS headers for stage custom domain on prod env", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        headers: { origin: "https://stage.meterwise.app" },
      });
      const original = Response.json({ data: {} }, { status: 200 });
      const res = applyCorsHeaders(original, req, prodEnv);

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("does not add CORS headers for stage workers.dev origin on prod env", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        headers: { origin: STAGE_WORKER_ORIGIN },
      });
      const original = Response.json({ data: {} }, { status: 200 });
      const res = applyCorsHeaders(original, req, prodEnv);

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("does not add CORS headers for disallowed origin", () => {
      const req = new Request("https://api.test/v1/auth/session", {
        headers: { origin: "https://evil.com" },
      });
      const original = Response.json({ data: {} }, { status: 200 });
      const res = applyCorsHeaders(original, req, stageEnv);

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("preserves original response status and body", async () => {
      const req = new Request("https://api.test/v1/auth/session", {
        headers: { origin: "http://localhost:5173" },
      });
      const body = { error: { code: "unauthenticated", message: "No token" } };
      const original = Response.json(body, { status: 401 });
      const res = applyCorsHeaders(original, req, stageEnv);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual(body);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    });
  });
});
