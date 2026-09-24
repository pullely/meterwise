// M0 / Solo profile — the membership-worker side of the single SOLO_MODE switch.
//
// Under the Solo profile the user IS the tenant: each account owns exactly ONE
// (invisible) personal organization. api-edge suppresses the collaboration and
// platform surfaces, but it cannot enforce the one-org rule — deciding whether a
// `POST /v1/organizations` is the account's *bootstrap* org or an illegal
// *second* one requires counting the actor's orgs, which only this worker does
// (the MO2 gate already loads exactly that list).
//
// So the rule lives here: bootstrap is allowed (that is what makes
// auto-provisioning — and the console's onboarding fallback when
// auto-provisioning didn't land — work at all), every additional org is denied
// regardless of the account's billing entitlements.
//
// Same contract as the other surfaces: a deploy-time var, absent/non-"true"
// meaning the full multi-tenant baseline. See specs/profiles/solo-m0.md.

import type { Env } from "./env.js";

/** Is this instance running the M0/Solo profile? (deploy-time wrangler var) */
export function isSoloMode(env: Env): boolean {
  return env.SOLO_MODE === "true";
}
