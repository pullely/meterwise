// Tests for `EventsClient.iterAuditEntries` async iterator (Task 0102 —
// closes Task 0101 audit-pagination spec gap).
//
// The single-page `listAuditEntries` primitive is already covered in
// `resources.test.ts`; this file focuses on the new iterator's
// multi-page consumption + loop guards.

import { describe, expect, it, vi } from "vitest";

import { Meterwise, AUDIT_ITERATOR_MAX_PAGES } from "../index.js";
import type { PublicAuditEntry } from "@saas/contracts/events";

interface PageMeta {
  cursor: string | null;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * Build a fetch responder that serves the supplied pages in order. Each call
 * advances to the next page; once the array is exhausted the responder
 * throws (signals "iterator should have stopped").
 */
function pageResponder(
  pages: ReadonlyArray<{
    entries: ReadonlyArray<Partial<PublicAuditEntry>>;
    meta: PageMeta;
  }>,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (i >= pages.length) {
      throw new Error(
        `pageResponder: iterator made an unexpected request (i=${i}, pages=${pages.length}, url=${String(input)})`,
      );
    }
    const page = pages[i]!;
    i += 1;
    return jsonResponse({
      data: { auditEntries: page.entries },
      meta: { requestId: `req_${i}`, cursor: page.meta.cursor },
    });
  });
  return { fetch: fn, calls };
}

function entry(id: string, occurredAt: string): Partial<PublicAuditEntry> {
  return {
    id,
    eventType: "test.event",
    category: "test",
    occurredAt,
    actorType: "user",
    actorId: "usr_a",
  };
}

function client(fetchImpl: typeof fetch): Meterwise {
  return new Meterwise({ baseUrl: "https://api.test", fetch: fetchImpl });
}

describe("EventsClient.iterAuditEntries", () => {
  it("walks ≥ 2 pages via for await and preserves server order", async () => {
    const { fetch, calls } = pageResponder([
      {
        entries: [entry("ae_1", "2025-01-01T00:00:00Z"), entry("ae_2", "2025-01-02T00:00:00Z")],
        meta: { cursor: "cur_2" },
      },
      {
        entries: [entry("ae_3", "2025-01-03T00:00:00Z")],
        meta: { cursor: null },
      },
    ]);
    const collected: string[] = [];
    for await (const e of client(fetch).events.iterAuditEntries("org_1")) {
      collected.push(e.id);
    }
    expect(collected).toEqual(["ae_1", "ae_2", "ae_3"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/audit");
    expect(calls[1]!.url).toContain("cursor=cur_2");
  });

  it("terminates after a single page when cursor is null on the first response", async () => {
    const { fetch, calls } = pageResponder([
      { entries: [entry("ae_only", "2025-01-01T00:00:00Z")], meta: { cursor: null } },
    ]);
    const ids: string[] = [];
    for await (const e of client(fetch).events.iterAuditEntries("org_1")) {
      ids.push(e.id);
    }
    expect(ids).toEqual(["ae_only"]);
    expect(calls).toHaveLength(1);
  });

  it("terminates when cursor is undefined (server omits the field)", async () => {
    const fn: typeof fetch = vi.fn(
      async () =>
        jsonResponse({
          data: { auditEntries: [entry("ae_x", "2025-01-01T00:00:00Z")] },
          meta: { requestId: "req_x" }, // no cursor field at all
        }),
    );
    const ids: string[] = [];
    for await (const e of client(fn).events.iterAuditEntries("org_1")) {
      ids.push(e.id);
    }
    expect(ids).toEqual(["ae_x"]);
  });

  it("forwards by:org category + limit on every page request", async () => {
    const { fetch, calls } = pageResponder([
      { entries: [], meta: { cursor: "cur_2" } },
      { entries: [], meta: { cursor: null } },
    ]);
    const it = client(fetch).events.iterAuditEntries("org_1", {
      by: "org",
      category: "membership",
      limit: 25,
    });
    for await (const _e of it) {
      void _e;
    }
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toContain("category=membership");
      expect(c.url).toContain("limit=25");
    }
    expect(calls[1]!.url).toContain("cursor=cur_2");
  });

  it("forwards by:target subjectKind+subjectId on every page request", async () => {
    const { fetch, calls } = pageResponder([
      { entries: [], meta: { cursor: "cur_2" } },
      { entries: [], meta: { cursor: null } },
    ]);
    const it = client(fetch).events.iterAuditEntries("org_1", {
      by: "target",
      subjectKind: "project",
      subjectId: "prj_1",
    });
    for await (const _e of it) {
      void _e;
    }
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toContain("subjectKind=project");
      expect(c.url).toContain("subjectId=prj_1");
    }
  });

  it("aborts with a clear error when the server returns a repeated cursor", async () => {
    // Page 1 returns cursor "cur_X"; page 2 returns the SAME cursor — server
    // is misbehaving / cycling. The iterator must throw rather than loop.
    const { fetch } = pageResponder([
      { entries: [entry("ae_1", "2025-01-01T00:00:00Z")], meta: { cursor: "cur_X" } },
      { entries: [entry("ae_2", "2025-01-02T00:00:00Z")], meta: { cursor: "cur_X" } },
    ]);
    const collected: string[] = [];
    await expect(
      (async () => {
        for await (const e of client(fetch).events.iterAuditEntries("org_1")) {
          collected.push(e.id);
        }
      })(),
    ).rejects.toThrow(/repeated cursor/);
    // The iterator yields page 1's entries, then on the next refill it
    // fetches page 2, sees the repeated cursor, and throws BEFORE yielding
    // any of page 2's entries. So only `ae_1` is observed by the caller.
    expect(collected).toEqual(["ae_1"]);
  });

  it("propagates a fetch error mid-iteration (abort-on-error)", async () => {
    let i = 0;
    const fn: typeof fetch = vi.fn(async () => {
      i += 1;
      if (i === 1) {
        return jsonResponse({
          data: { auditEntries: [entry("ae_1", "2025-01-01T00:00:00Z")] },
          meta: { requestId: "req_1", cursor: "cur_2" },
        });
      }
      throw new Error("network down");
    });
    const collected: string[] = [];
    await expect(
      (async () => {
        for await (const e of client(fn).events.iterAuditEntries("org_1")) {
          collected.push(e.id);
        }
      })(),
    ).rejects.toThrow(/network down/);
    expect(collected).toEqual(["ae_1"]);
  });

  it("exposes a sane page cap so a runaway server cannot loop indefinitely", () => {
    // Sanity-check: the cap is exported and ≥ 1000 (per Task 0102 contract).
    expect(AUDIT_ITERATOR_MAX_PAGES).toBeGreaterThanOrEqual(1000);
  });

  it("forwards by:org filter params on every page request", async () => {
    const { fetch, calls } = pageResponder([
      { entries: [], meta: { cursor: "cur_2" } },
      { entries: [], meta: { cursor: null } },
    ]);
    const it = client(fetch).events.iterAuditEntries("org_1", {
      by: "org",
      actorId: "usr_a",
      actorType: "user",
      subjectKind: "project",
      subjectId: "prj_1",
      eventType: "member.role_changed",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
    for await (const _e of it) {
      void _e;
    }
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toContain("actorId=usr_a");
      expect(c.url).toContain("actorType=user");
      expect(c.url).toContain("subjectKind=project");
      expect(c.url).toContain("subjectId=prj_1");
      expect(c.url).toContain("eventType=member.role_changed");
      expect(c.url).toContain("from=2026-01-01T00%3A00%3A00.000Z");
      expect(c.url).toContain("to=2026-02-01T00%3A00%3A00.000Z");
    }
    expect(calls[1]!.url).toContain("cursor=cur_2");
  });
});

describe("EventsClient.exportAuditEntriesNdjson", () => {
  it("yields one NDJSON line per entry across pages", async () => {
    const { fetch } = pageResponder([
      {
        entries: [entry("ae_1", "2025-01-01T00:00:00Z"), entry("ae_2", "2025-01-02T00:00:00Z")],
        meta: { cursor: "cur_2" },
      },
      { entries: [entry("ae_3", "2025-01-03T00:00:00Z")], meta: { cursor: null } },
    ]);
    const lines: string[] = [];
    for await (const line of client(fetch).events.exportAuditEntriesNdjson("org_1")) {
      lines.push(line);
    }
    expect(lines).toHaveLength(3);
    // Each line is a standalone JSON document terminated by a newline.
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line.trimEnd());
      expect(typeof parsed.id).toBe("string");
    }
    expect(JSON.parse(lines[0]!.trimEnd()).id).toBe("ae_1");
    expect(JSON.parse(lines[2]!.trimEnd()).id).toBe("ae_3");
  });

  it("forwards filters into the export stream", async () => {
    const { fetch, calls } = pageResponder([
      { entries: [entry("ae_1", "2025-01-01T00:00:00Z")], meta: { cursor: null } },
    ]);
    const lines: string[] = [];
    for await (const line of client(fetch).events.exportAuditEntriesNdjson("org_1", {
      by: "org",
      actorType: "service_principal",
      from: "2026-01-01T00:00:00.000Z",
    })) {
      lines.push(line);
    }
    expect(lines).toHaveLength(1);
    expect(calls[0]!.url).toContain("actorType=service_principal");
    expect(calls[0]!.url).toContain("from=2026-01-01T00%3A00%3A00.000Z");
  });

  it("yields nothing for an empty result set", async () => {
    const { fetch } = pageResponder([{ entries: [], meta: { cursor: null } }]);
    const lines: string[] = [];
    for await (const line of client(fetch).events.exportAuditEntriesNdjson("org_1")) {
      lines.push(line);
    }
    expect(lines).toEqual([]);
  });
});
