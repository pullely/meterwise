// Provider-payload → versioned `scm.*` projection (design §6, R7).
//
// Pure functions over the persisted raw payload: the drain (and replay) call
// this with data already verified at ingest time — nothing here re-trusts the
// wire. Projections are compact and additive-only; the raw payload stays in
// the inbox for richer re-derivation later.

import {
  SCM_EVENT_TYPES,
  type ScmEventType,
  type ScmRepoRef,
} from "@saas/contracts/integrations";

export interface NormalizedScmEvent {
  type: ScmEventType;
  /** Envelope-payload projection (version 1). */
  payload: Record<string, unknown>;
  repo: ScmRepoRef;
}

const MAX_COMMITS = 20;
const MAX_MESSAGE_LENGTH = 200;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function repoRef(payload: Record<string, unknown>): ScmRepoRef | null {
  const repository = record(payload.repository);
  if (!repository) return null;
  const fullName = str(repository.full_name);
  const id = repository.id;
  if (!fullName || (typeof id !== "number" && typeof id !== "string")) return null;
  return { provider: "github", externalId: String(id), fullName };
}

function base(
  orgPublicId: string,
  repo: ScmRepoRef,
): Record<string, unknown> {
  return {
    version: 1,
    orgId: orgPublicId,
    // Per-project enrichment (repo links + branch → environment) lands in IG3.
    projectId: null,
    environment: null,
    repo,
  };
}

function branchFromRef(ref: string | null): string | null {
  if (!ref) return null;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

/**
 * Map a verified GitHub delivery to a normalized scm.* event, or null when
 * the (event, action) pair is outside the supported taxonomy — the drain
 * marks those `skipped`, never `failed`.
 */
export function normalizeScmEvent(
  eventType: string,
  action: string | null,
  payload: Record<string, unknown>,
  orgPublicId: string,
): NormalizedScmEvent | null {
  const repo = repoRef(payload);
  if (!repo) return null;

  switch (eventType) {
    case "push": {
      const ref = str(payload.ref);
      const rawCommits = Array.isArray(payload.commits) ? payload.commits : [];
      const commits = rawCommits.slice(0, MAX_COMMITS).flatMap((c) => {
        const commit = record(c);
        if (!commit) return [];
        const author = record(commit.author);
        return [
          {
            sha: str(commit.id) ?? "",
            message: (str(commit.message) ?? "").slice(0, MAX_MESSAGE_LENGTH),
            authorLogin: author ? str(author.username) : null,
          },
        ];
      });
      const pusher = record(payload.pusher);
      return {
        type: SCM_EVENT_TYPES.PUSH,
        repo,
        payload: {
          ...base(orgPublicId, repo),
          ref: ref ?? "",
          branch: branchFromRef(ref),
          beforeSha: str(payload.before) ?? "",
          afterSha: str(payload.after) ?? "",
          commits,
          pusherLogin: pusher ? str(pusher.name) : null,
        },
      };
    }

    case "pull_request": {
      const pr = record(payload.pull_request);
      if (!pr) return null;
      let type: ScmEventType;
      let state: "open" | "closed" | "merged";
      switch (action) {
        case "opened":
          type = SCM_EVENT_TYPES.PULL_REQUEST_OPENED;
          state = "open";
          break;
        case "synchronize":
        case "edited":
        case "reopened":
        case "ready_for_review":
          type = SCM_EVENT_TYPES.PULL_REQUEST_UPDATED;
          state = "open";
          break;
        case "closed":
          if (pr.merged === true) {
            type = SCM_EVENT_TYPES.PULL_REQUEST_MERGED;
            state = "merged";
          } else {
            type = SCM_EVENT_TYPES.PULL_REQUEST_CLOSED;
            state = "closed";
          }
          break;
        default:
          return null; // labeled, assigned, review_requested, … — out of taxonomy
      }
      const head = record(pr.head);
      const prBase = record(pr.base);
      const user = record(pr.user);
      if (typeof pr.number !== "number" || !head || !prBase) return null;
      return {
        type,
        repo,
        payload: {
          ...base(orgPublicId, repo),
          number: pr.number,
          title: str(pr.title) ?? "",
          state,
          sourceBranch: str(head.ref) ?? "",
          targetBranch: str(prBase.ref) ?? "",
          headSha: str(head.sha) ?? "",
          authorLogin: user ? str(user.login) : null,
          url: str(pr.html_url),
        },
      };
    }

    case "check_run": {
      if (action !== "completed") return null;
      const checkRun = record(payload.check_run);
      if (!checkRun) return null;
      return {
        type: SCM_EVENT_TYPES.CHECK_COMPLETED,
        repo,
        payload: {
          ...base(orgPublicId, repo),
          checkName: str(checkRun.name) ?? "",
          conclusion: str(checkRun.conclusion),
          headSha: str(checkRun.head_sha) ?? "",
          url: str(checkRun.html_url),
        },
      };
    }

    case "release": {
      if (action !== "published") return null;
      const release = record(payload.release);
      if (!release) return null;
      return {
        type: SCM_EVENT_TYPES.RELEASE_PUBLISHED,
        repo,
        payload: {
          ...base(orgPublicId, repo),
          tagName: str(release.tag_name) ?? "",
          releaseName: str(release.name),
          url: str(release.html_url),
        },
      };
    }

    case "create": {
      const ref = str(payload.ref);
      if (!ref) return null;
      if (payload.ref_type === "branch") {
        return {
          type: SCM_EVENT_TYPES.BRANCH_CREATED,
          repo,
          payload: { ...base(orgPublicId, repo), branch: ref },
        };
      }
      if (payload.ref_type === "tag") {
        return {
          type: SCM_EVENT_TYPES.TAG_CREATED,
          repo,
          payload: { ...base(orgPublicId, repo), tag: ref },
        };
      }
      return null;
    }

    case "delete": {
      const ref = str(payload.ref);
      if (!ref || payload.ref_type !== "branch") return null;
      return {
        type: SCM_EVENT_TYPES.BRANCH_DELETED,
        repo,
        payload: { ...base(orgPublicId, repo), branch: ref },
      };
    }

    default:
      return null;
  }
}

/** Provider events that mutate connection/installation state in the drain. */
export const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "installation",
  "installation_repositories",
  "github_app_authorization",
]);

/** Extract the installation id every attributable GitHub delivery carries. */
export function installationIdFromPayload(payload: Record<string, unknown>): number | null {
  const installation = record(payload.installation);
  if (!installation) return null;
  return typeof installation.id === "number" ? installation.id : null;
}
