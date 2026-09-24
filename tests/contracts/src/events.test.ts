import type {
  EventEnvelope,
  EventActor,
  EventTenant,
  EventSubject,
  EventTrace,
  EventAuditMeta,
  AuditEntry,
  AuditQueryByOrg,
  AuditQueryByTarget,
  PublicAuditEntry,
  ListAuditEntriesResponse,
} from "@saas/contracts";

describe("contracts: event envelope types", () => {
  it("EventEnvelope shape matches the schema", () => {
    const envelope: EventEnvelope = {
      id: "evt_01hxyz",
      type: "project.created",
      version: 1,
      source: "projects-worker",
      occurredAt: "2026-04-22T12:00:00Z",
      actor: {
        type: "user",
        id: "usr_123",
        sessionId: "ses_123",
        ip: "203.0.113.10",
      },
      tenant: {
        orgId: "org_123",
        projectId: "prj_123",
        environmentId: null,
      },
      subject: {
        kind: "project",
        id: "prj_123",
        name: "Acme API",
      },
      trace: {
        requestId: "req_123",
        correlationId: "cor_123",
        causationId: null,
        idempotencyKey: "idem_123",
      },
      payload: { projectId: "prj_123", name: "Acme API" },
    };

    expect(envelope.id).toBe("evt_01hxyz");
    expect(envelope.type).toBe("project.created");
    expect(envelope.version).toBe(1);
    expect(envelope.actor.type).toBe("user");
    expect(envelope.tenant.orgId).toBe("org_123");
    expect(envelope.subject.kind).toBe("project");
    expect(envelope.trace.requestId).toBe("req_123");
    expect(envelope.payload).toBeDefined();
  });

  it("EventEnvelope supports optional audit redaction metadata", () => {
    const envelope: EventEnvelope = {
      id: "evt_02",
      type: "member.invited",
      version: 1,
      source: "membership-worker",
      occurredAt: "2026-04-22T12:00:00Z",
      actor: { type: "system", id: "sys" },
      tenant: { orgId: "org_1" },
      subject: { kind: "invitation", id: "inv_1" },
      trace: { requestId: "req_2" },
      payload: { email: "test@example.com" },
      audit: { redact: ["$.payload.email"] },
    };

    expect(envelope.audit?.redact).toEqual(["$.payload.email"]);
  });

  it("EventActor supports all actor types", () => {
    const actors: EventActor[] = [
      { type: "user", id: "u1" },
      { type: "service_principal", id: "sp1" },
      { type: "workflow", id: "wf1" },
      { type: "system", id: "sys" },
    ];
    expect(actors).toHaveLength(4);
  });

  it("EventTenant requires orgId, optional projectId/environmentId", () => {
    const tenant: EventTenant = { orgId: "org_1" };
    expect(tenant.orgId).toBe("org_1");
    expect(tenant.projectId).toBeUndefined();

    const full: EventTenant = { orgId: "org_2", projectId: "prj_1", environmentId: "env_1" };
    expect(full.projectId).toBe("prj_1");
  });

  it("EventSubject requires kind and id, optional name", () => {
    const s: EventSubject = { kind: "project", id: "prj_1" };
    expect(s.name).toBeUndefined();
  });

  it("EventTrace requires requestId, optional correlation/causation/idempotency", () => {
    const t: EventTrace = { requestId: "req_1" };
    expect(t.correlationId).toBeUndefined();
  });

  it("EventAuditMeta redact is optional array of strings", () => {
    const meta: EventAuditMeta = { redact: ["$.a", "$.b"] };
    expect(meta.redact).toHaveLength(2);
  });
});

describe("contracts: audit entry types", () => {
  it("AuditEntry shape is structurally correct", () => {
    const entry: AuditEntry = {
      id: "aud_1",
      eventId: "evt_1",
      orgId: "org_1",
      projectId: null,
      environmentId: null,
      actorType: "user",
      actorId: "usr_1",
      eventType: "organization.created",
      eventVersion: 1,
      source: "membership-worker",
      subjectKind: "organization",
      subjectId: "org_1",
      subjectName: "Acme",
      category: "general",
      description: "Organization created",
      occurredAt: "2026-01-15T10:00:00Z",
      requestId: "req_1",
      correlationId: null,
      payload: {},
      redactPaths: [],
    };

    expect(entry.orgId).toBe("org_1");
    expect(entry.eventId).toBe("evt_1");
    expect(entry.redactPaths).toEqual([]);
  });
});

describe("contracts: audit query filter types", () => {
  it("AuditQueryByOrg is structurally valid", () => {
    const q: AuditQueryByOrg = { orgId: "org_1", limit: 20 };
    expect(q.orgId).toBe("org_1");
    expect(q.cursor).toBeUndefined();
  });

  it("AuditQueryByTarget includes subject kind/id", () => {
    const q: AuditQueryByTarget = {
      orgId: "org_1",
      subjectKind: "project",
      subjectId: "prj_1",
      limit: 10,
      cursor: "cur_abc",
    };
    expect(q.subjectKind).toBe("project");
    expect(q.cursor).toBe("cur_abc");
  });
});

describe("contracts: public audit response types", () => {
  it("PublicAuditEntry shape is structurally correct", () => {
    const entry: PublicAuditEntry = {
      id: "aud_1",
      eventId: "evt_1",
      orgId: "org_abc123",
      projectId: "prj_def456",
      environmentId: null,
      actorType: "user",
      actorId: "usr_1",
      eventType: "project.created",
      source: "projects-worker",
      category: "projects",
      description: "Project created",
      subject: {
        kind: "project",
        id: "prj_def456",
        name: "Acme API",
      },
      occurredAt: "2026-05-26T10:00:00.000Z",
      requestId: "req_1",
      correlationId: null,
      payload: { name: "Acme API" },
    };

    expect(entry.orgId).toBe("org_abc123");
    expect(entry.subject.kind).toBe("project");
    expect(entry.subject.id).toBe("prj_def456");
    expect(entry.payload).toEqual({ name: "Acme API" });
  });

  it("ListAuditEntriesResponse envelope shape", () => {
    const response: ListAuditEntriesResponse = {
      data: {
        auditEntries: [],
      },
      meta: {
        requestId: "req_1",
        cursor: null,
      },
    };

    expect(response.data.auditEntries).toEqual([]);
    expect(response.meta.cursor).toBeNull();
  });

  it("ListAuditEntriesResponse with cursor", () => {
    const response: ListAuditEntriesResponse = {
      data: {
        auditEntries: [{
          id: "aud_1",
          eventId: "evt_1",
          orgId: "org_abc",
          projectId: null,
          environmentId: null,
          actorType: "user",
          actorId: "usr_1",
          eventType: "organization.created",
          source: "membership-worker",
          category: "general",
          description: "Org created",
          subject: { kind: "organization", id: "org_abc", name: "Acme" },
          occurredAt: "2026-05-26T10:00:00.000Z",
          requestId: "req_1",
          correlationId: null,
          payload: {},
        }],
      },
      meta: {
        requestId: "req_1",
        cursor: "eyJ2IjoxLCJ0IjoiMjAyNi0wNS0yNiJ9",
      },
    };

    expect(response.data.auditEntries).toHaveLength(1);
    expect(response.meta.cursor).not.toBeNull();
  });
});
