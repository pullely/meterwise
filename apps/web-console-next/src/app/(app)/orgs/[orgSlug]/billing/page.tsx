import { redirect } from "next/navigation";

/**
 * Compatibility redirect. Organization administration moved under the dedicated
 * Settings surface; this keeps old links to `/orgs/[slug]/billing` working.
 */
export default function LegacyRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/settings/billing`);
}
