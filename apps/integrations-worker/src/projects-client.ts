// Internal call to projects-worker: resolve a project's live environments so
// branch → environment maps validate against reality (IG3). Fails closed.

export type ProjectEnvironmentsResult =
  | { ok: true; slugs: string[] }
  | { ok: false };

export async function fetchProjectEnvironmentSlugs(
  projectsWorker: Fetcher,
  orgId: string,
  projectId: string,
  requestId: string,
): Promise<ProjectEnvironmentsResult> {
  let response: Response;
  try {
    const target = new URL("/v1/internal/projects/environments", "http://projects-worker");
    target.searchParams.set("orgId", orgId);
    target.searchParams.set("projectId", projectId);
    response = await projectsWorker.fetch(target.toString(), {
      method: "GET",
      headers: { "x-request-id": requestId },
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return { ok: false };
  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("environments" in data)) return { ok: false };
  const environments = (data as { environments: unknown }).environments;
  if (!Array.isArray(environments)) return { ok: false };

  const slugs = environments
    .map((e) => (e && typeof e === "object" ? (e as { slug?: unknown }).slug : null))
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return { ok: true, slugs };
}
