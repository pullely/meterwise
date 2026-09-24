# integrations-worker

The inbound half of third-party integrations (GitHub App first): provider
connections, the HMAC-verified inbound webhook inbox, normalized `scm.*`
events on the platform event log, repo ↔ project links, and the
installation-token broker. Contract: `specs/components/17-integrations.md`.

## Recipe: act on GitHub from your product

Your backend holds one Meterwise API key and **zero GitHub credentials**.
Exchange it for a short-lived, repo-scoped installation token whenever you
need to call GitHub — post a check run, read a file, set a deploy status:

```ts
import { Meterwise } from "@saas/sdk";
import { Octokit } from "@octokit/rest";

const meterwise = new Meterwise({
  baseUrl: process.env.METERWISE_API_URL!,
  token: process.env.METERWISE_API_KEY!, // service-principal key
});

// Mint a token scoped to exactly the repos + permissions you need.
// TTL ≤ 1h; mint per task and let it expire — never store it.
const { token } = await meterwise.integrations.issueGithubToken(ORG_ID, {
  repositories: ["777001"],                 // linked provider repo ids
  permissions: { checks: "write" },         // ⊆ the App's grant
});

const octokit = new Octokit({ auth: token });
await octokit.checks.create({
  owner: "acme",
  repo: "storefront",
  name: "meterwise/verify",
  head_sha: headSha,
  status: "completed",
  conclusion: "success",
});
```

CLI equivalent for scripts and debugging:

```sh
sourceplane integrations github token \
  --repos=777001 \
  --permissions=checks:write,contents:read
```

Rules the broker enforces (deny-by-default): every requested repository must
be **linked to a project** in your organization, all of them on one
connection; requested permissions must be **within the App's granted
permissions**; issuance requires the `organization.integration.token.issue`
policy action (owner/admin or a service principal holding such a role) and
is **audited** — actor, repos, permissions — never the token itself.

## Recipe: react to pushes and pull requests

Nothing new to integrate: linked repos emit normalized `scm.*` events
(`scm.push`, `scm.pull_request.opened|updated|merged|closed`, …) onto the
platform event log, which fans out to your existing outbound webhook
endpoints with the standard signing — verify with `@saas/webhook-verifier`
exactly like any other platform event. Events for repos linked to a project
carry `projectId` and the environment resolved from your branch map.
