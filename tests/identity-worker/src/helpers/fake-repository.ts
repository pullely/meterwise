import type {
  IdentityRepository,
  IdentityResult,
  User,
  AuthIdentity,
  LoginChallenge,
  Session,
  SecurityEvent,
  CreateUserInput,
  CreateAuthIdentityInput,
  CreateLoginChallengeInput,
  CreateSessionInput,
  CreateSecurityEventInput,
  SecurityEventPageQueryParams,
  SecurityEventPagedResult,
  UpdateUserProfileInput,
  ApiKey,
  ServicePrincipal,
  CreateServicePrincipalInput,
  CreateApiKeyInput,
  ApiKeyPageQueryParams,
  ApiKeyPagedResult,
} from "@saas/db/identity";

interface StoredChallenge extends LoginChallenge {
  codeHash: string;
}

interface StoredSession extends Session {
  tokenHash: string;
}

export function createFakeRepository(): IdentityRepository & {
  _users: Map<string, User>;
  _authIdentities: Map<string, AuthIdentity>;
  _challenges: Map<string, StoredChallenge>;
  _sessions: Map<string, StoredSession>;
  _securityEvents: SecurityEvent[];
  _apiKeys: Map<string, ApiKey & { keyHash: string }>;
  _servicePrincipals: Map<string, ServicePrincipal>;
} {
  const users = new Map<string, User>();
  const authIdentities = new Map<string, AuthIdentity>();
  const challenges = new Map<string, StoredChallenge>();
  const sessions = new Map<string, StoredSession>();
  const securityEvents: SecurityEvent[] = [];
  const apiKeys = new Map<string, ApiKey & { keyHash: string }>();
  const servicePrincipals = new Map<string, ServicePrincipal>();

  const repo: IdentityRepository & {
    _users: Map<string, User>;
    _authIdentities: Map<string, AuthIdentity>;
    _challenges: Map<string, StoredChallenge>;
    _sessions: Map<string, StoredSession>;
    _securityEvents: SecurityEvent[];
    _apiKeys: Map<string, ApiKey & { keyHash: string }>;
    _servicePrincipals: Map<string, ServicePrincipal>;
  } = {
    _users: users,
    _authIdentities: authIdentities,
    _challenges: challenges,
    _sessions: sessions,
    _securityEvents: securityEvents,
    _apiKeys: apiKeys,
    _servicePrincipals: servicePrincipals,

    async createUser(input: CreateUserInput): Promise<IdentityResult<User>> {
      if (users.has(input.id)) {
        return { ok: false, error: { kind: "conflict", entity: "user" } };
      }
      for (const u of users.values()) {
        if (u.emailLower === input.emailLower) {
          return { ok: false, error: { kind: "conflict", entity: "user" } };
        }
      }
      const user: User = {
        id: input.id,
        email: input.email,
        emailLower: input.emailLower,
        displayName: input.displayName ?? null,
        lastOrgSlug: null,
        status: "active",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      users.set(input.id, user);
      return { ok: true, value: user };
    },

    async getUserById(id: string): Promise<IdentityResult<User>> {
      const user = users.get(id);
      if (!user) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: user };
    },

    async getUserByEmail(emailLower: string): Promise<IdentityResult<User>> {
      for (const u of users.values()) {
        if (u.emailLower === emailLower) return { ok: true, value: u };
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async updateUserProfile(userId: string, input: UpdateUserProfileInput): Promise<IdentityResult<User>> {
      const user = users.get(userId);
      if (!user) return { ok: false, error: { kind: "not_found" } };
      if (input.displayName !== undefined) user.displayName = input.displayName;
      if (input.lastOrgSlug !== undefined) user.lastOrgSlug = input.lastOrgSlug;
      user.updatedAt = input.updatedAt;
      return { ok: true, value: user };
    },

    async createAuthIdentity(input: CreateAuthIdentityInput): Promise<IdentityResult<AuthIdentity>> {
      const identity: AuthIdentity = {
        id: input.id,
        userId: input.userId,
        provider: input.provider,
        subject: input.subject,
        metadata: input.metadata ?? {},
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      authIdentities.set(input.id, identity);
      return { ok: true, value: identity };
    },

    async getAuthIdentityByProviderSubject(provider: string, subject: string): Promise<IdentityResult<AuthIdentity>> {
      for (const ai of authIdentities.values()) {
        if (ai.provider === provider && ai.subject === subject) {
          return { ok: true, value: ai };
        }
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async createLoginChallenge(input: CreateLoginChallengeInput): Promise<IdentityResult<LoginChallenge>> {
      const challenge: StoredChallenge = {
        id: input.id,
        userId: input.userId,
        method: input.method,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: input.createdAt,
        codeHash: input.codeHash,
      };
      challenges.set(input.id, challenge);
      return { ok: true, value: challenge };
    },

    async getLoginChallengeById(id: string): Promise<IdentityResult<LoginChallenge>> {
      const c = challenges.get(id);
      if (!c) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: c };
    },

    async consumeLoginChallenge(id: string, codeHash: string, consumedAt: Date): Promise<IdentityResult<LoginChallenge>> {
      const c = challenges.get(id);
      if (!c) return { ok: false, error: { kind: "not_found" } };
      if (c.consumedAt !== null) return { ok: false, error: { kind: "already_consumed" } };
      if (c.expiresAt.getTime() <= consumedAt.getTime()) return { ok: false, error: { kind: "expired" } };
      if (c.codeHash !== codeHash) return { ok: false, error: { kind: "not_found" } };
      c.consumedAt = consumedAt;
      return { ok: true, value: c };
    },

    async createSession(input: CreateSessionInput): Promise<IdentityResult<Session>> {
      const session: StoredSession = {
        id: input.id,
        userId: input.userId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: input.createdAt,
        lastSeenAt: input.createdAt,
        tokenHash: input.tokenHash,
      };
      sessions.set(input.id, session);
      return { ok: true, value: session };
    },

    async getSessionByTokenHash(tokenHash: string): Promise<IdentityResult<Session>> {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) return { ok: true, value: s };
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async getSessionWithUserByTokenHash(
      tokenHash: string,
    ): Promise<IdentityResult<{ session: Session; user: User }>> {
      // Mirrors getSessionByTokenHash (no revoked/expired filter — the service
      // applies those) + getUserById, as one folded lookup (PERF12d).
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) {
          const user = users.get(s.userId);
          if (!user) return { ok: false, error: { kind: "not_found" } };
          return { ok: true, value: { session: s, user } };
        }
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async revokeSession(id: string, revokedAt: Date): Promise<IdentityResult<Session>> {
      const s = sessions.get(id);
      if (!s) return { ok: false, error: { kind: "not_found" } };
      s.revokedAt = revokedAt;
      return { ok: true, value: s };
    },

    async recordSecurityEvent(input: CreateSecurityEventInput): Promise<IdentityResult<SecurityEvent>> {
      const event: SecurityEvent = {
        id: input.id,
        eventType: input.eventType,
        outcome: input.outcome,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        challengeId: input.challengeId ?? null,
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        occurredAt: input.occurredAt ?? new Date(),
        createdAt: new Date(),
        metadata: input.metadata ?? {},
        redactPaths: input.redactPaths ?? [],
      };
      securityEvents.push(event);
      return { ok: true, value: event };
    },

    async querySecurityEventsByUser(params: SecurityEventPageQueryParams): Promise<IdentityResult<SecurityEventPagedResult>> {
      const userEvents = securityEvents
        .filter((e) => e.userId === params.userId)
        .sort((a, b) => {
          const timeDiff = b.occurredAt.getTime() - a.occurredAt.getTime();
          if (timeDiff !== 0) return timeDiff;
          return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
        });

      let filtered = userEvents;
      if (params.cursor) {
        const cursorTime = new Date(params.cursor.occurredAt).getTime();
        filtered = userEvents.filter((e) => {
          const t = e.occurredAt.getTime();
          return t < cursorTime || (t === cursorTime && e.id < params.cursor!.id);
        });
      }

      const fetchLimit = params.limit + 1;
      const page = filtered.slice(0, fetchLimit);

      let nextCursor = null;
      if (page.length > params.limit) {
        page.pop();
        const last = page[page.length - 1]!;
        nextCursor = { occurredAt: last.occurredAt.toISOString(), id: last.id };
      }

      return { ok: true, value: { items: page, nextCursor } };
    },

    async createServicePrincipal(input: CreateServicePrincipalInput): Promise<IdentityResult<ServicePrincipal>> {
      const sp: ServicePrincipal = {
        id: input.id,
        orgId: input.orgId,
        projectId: input.projectId ?? null,
        displayName: input.displayName,
        description: input.description ?? null,
        status: "active",
        createdBy: input.createdBy,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      servicePrincipals.set(input.id, sp);
      return { ok: true, value: sp };
    },

    async getServicePrincipalById(id: string): Promise<IdentityResult<ServicePrincipal>> {
      const sp = servicePrincipals.get(id);
      if (!sp) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: sp };
    },

    async listServicePrincipalsByOrg(orgId: string): Promise<IdentityResult<ServicePrincipal[]>> {
      const result = [...servicePrincipals.values()].filter(sp => sp.orgId === orgId);
      return { ok: true, value: result };
    },

    async createApiKey(input: CreateApiKeyInput): Promise<IdentityResult<ApiKey>> {
      const key: ApiKey & { keyHash: string } = {
        id: input.id,
        servicePrincipalId: input.servicePrincipalId,
        orgId: input.orgId,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        label: input.label ?? "",
        status: "active",
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
        revokedBy: null,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      apiKeys.set(input.id, key);
      return { ok: true, value: key };
    },

    async getApiKeyByKeyHash(keyHash: string): Promise<IdentityResult<ApiKey>> {
      for (const k of apiKeys.values()) {
        if (k.keyHash === keyHash) return { ok: true, value: k };
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async listApiKeysByOrg(params: ApiKeyPageQueryParams): Promise<IdentityResult<ApiKeyPagedResult>> {
      const orgKeys = [...apiKeys.values()].filter(k => k.orgId === params.orgId);
      return { ok: true, value: { items: orgKeys, nextCursor: null } };
    },

    async revokeApiKey(id: string, revokedBy: string, revokedAt: Date): Promise<IdentityResult<ApiKey>> {
      const k = apiKeys.get(id);
      if (!k) return { ok: false, error: { kind: "not_found" } };
      k.revokedAt = revokedAt;
      k.revokedBy = revokedBy;
      k.status = "revoked";
      return { ok: true, value: k };
    },
  };

  return repo;
}
