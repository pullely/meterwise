import {
  installationIdFromPayload,
  LIFECYCLE_EVENT_TYPES,
  normalizeScmEvent,
} from "@integrations-worker/normalize";

const ORG = "org_11111111111111111111111111111111";

// Recorded-shape GitHub fixtures (trimmed to the fields the projection reads).
const REPOSITORY = { id: 777001, full_name: "acme/storefront", name: "storefront" };

const PUSH_FIXTURE = {
  ref: "refs/heads/main",
  before: "aaa1111111111111111111111111111111111111",
  after: "bbb2222222222222222222222222222222222222",
  repository: REPOSITORY,
  pusher: { name: "octocat", email: "octocat@acme.dev" },
  installation: { id: 9912345 },
  commits: [
    {
      id: "bbb2222222222222222222222222222222222222",
      message: "fix: stop dropping the session cookie on refresh\n\nLong body ".padEnd(400, "x"),
      author: { name: "Octo Cat", email: "octocat@acme.dev", username: "octocat" },
    },
  ],
};

const PR_FIXTURE = (action: string, merged = false) => ({
  action,
  number: 42,
  pull_request: {
    number: 42,
    title: "Add checkout flow",
    state: action === "closed" ? "closed" : "open",
    merged,
    html_url: "https://github.com/acme/storefront/pull/42",
    user: { login: "octocat" },
    head: { ref: "feat/checkout", sha: "ccc333" },
    base: { ref: "main", sha: "ddd444" },
  },
  repository: REPOSITORY,
  installation: { id: 9912345 },
});

describe("normalizeScmEvent — fixture-driven taxonomy", () => {
  it("projects push into scm.push v1 (capped commits, branch from ref)", () => {
    const out = normalizeScmEvent("push", null, PUSH_FIXTURE, ORG);
    expect(out).not.toBeNull();
    expect(out!.type).toBe("scm.push");
    expect(out!.repo).toEqual({ provider: "github", externalId: "777001", fullName: "acme/storefront" });
    const p = out!.payload;
    expect(p.version).toBe(1);
    expect(p.orgId).toBe(ORG);
    expect(p.projectId).toBeNull();
    expect(p.branch).toBe("main");
    expect(p.beforeSha).toBe(PUSH_FIXTURE.before);
    const commits = p.commits as Array<Record<string, unknown>>;
    expect(commits).toHaveLength(1);
    expect((commits[0]!.message as string).length).toBeLessThanOrEqual(200);
    expect(commits[0]!.authorLogin).toBe("octocat");
    expect(p.pusherLogin).toBe("octocat");
    // Never the raw payload: no repository/installation echoes.
    expect(p.repository).toBeUndefined();
    expect(p.installation).toBeUndefined();
  });

  it("projects the pull_request action matrix", () => {
    expect(normalizeScmEvent("pull_request", "opened", PR_FIXTURE("opened"), ORG)!.type).toBe(
      "scm.pull_request.opened",
    );
    expect(
      normalizeScmEvent("pull_request", "synchronize", PR_FIXTURE("synchronize"), ORG)!.type,
    ).toBe("scm.pull_request.updated");
    const merged = normalizeScmEvent("pull_request", "closed", PR_FIXTURE("closed", true), ORG)!;
    expect(merged.type).toBe("scm.pull_request.merged");
    expect(merged.payload.state).toBe("merged");
    const closed = normalizeScmEvent("pull_request", "closed", PR_FIXTURE("closed", false), ORG)!;
    expect(closed.type).toBe("scm.pull_request.closed");
    // Out-of-taxonomy actions skip, never fail.
    expect(normalizeScmEvent("pull_request", "labeled", PR_FIXTURE("labeled"), ORG)).toBeNull();
  });

  it("projects check_run completed / release published / create / delete", () => {
    const check = normalizeScmEvent(
      "check_run",
      "completed",
      {
        action: "completed",
        check_run: { name: "ci/test", conclusion: "success", head_sha: "eee555", html_url: "https://x" },
        repository: REPOSITORY,
      },
      ORG,
    )!;
    expect(check.type).toBe("scm.check.completed");
    expect(check.payload.conclusion).toBe("success");
    expect(
      normalizeScmEvent("check_run", "created", { check_run: {}, repository: REPOSITORY }, ORG),
    ).toBeNull();

    const release = normalizeScmEvent(
      "release",
      "published",
      { release: { tag_name: "v1.2.0", name: "Spring", html_url: "https://r" }, repository: REPOSITORY },
      ORG,
    )!;
    expect(release.type).toBe("scm.release.published");
    expect(release.payload.tagName).toBe("v1.2.0");

    expect(
      normalizeScmEvent("create", null, { ref: "feat/x", ref_type: "branch", repository: REPOSITORY }, ORG)!.type,
    ).toBe("scm.branch.created");
    expect(
      normalizeScmEvent("create", null, { ref: "v2.0.0", ref_type: "tag", repository: REPOSITORY }, ORG)!.type,
    ).toBe("scm.tag.created");
    expect(
      normalizeScmEvent("delete", null, { ref: "feat/x", ref_type: "branch", repository: REPOSITORY }, ORG)!.type,
    ).toBe("scm.branch.deleted");
    // Tag deletes are out of taxonomy.
    expect(
      normalizeScmEvent("delete", null, { ref: "v2.0.0", ref_type: "tag", repository: REPOSITORY }, ORG),
    ).toBeNull();
  });

  it("returns null for unknown events or payloads without a repository", () => {
    expect(normalizeScmEvent("watch", "started", { repository: REPOSITORY }, ORG)).toBeNull();
    expect(normalizeScmEvent("push", null, { ref: "refs/heads/main" }, ORG)).toBeNull();
  });
});

describe("attribution helpers", () => {
  it("extracts the installation id", () => {
    expect(installationIdFromPayload(PUSH_FIXTURE)).toBe(9912345);
    expect(installationIdFromPayload({})).toBeNull();
    expect(installationIdFromPayload({ installation: { id: "not-a-number" } })).toBeNull();
  });

  it("declares the lifecycle taxonomy", () => {
    expect(LIFECYCLE_EVENT_TYPES.has("installation")).toBe(true);
    expect(LIFECYCLE_EVENT_TYPES.has("installation_repositories")).toBe(true);
    expect(LIFECYCLE_EVENT_TYPES.has("github_app_authorization")).toBe(true);
    expect(LIFECYCLE_EVENT_TYPES.has("push")).toBe(false);
  });
});
