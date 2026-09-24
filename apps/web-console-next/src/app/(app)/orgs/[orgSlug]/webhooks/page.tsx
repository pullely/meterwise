import { redirect } from "next/navigation";

/**
 * Compatibility redirect. Webhooks moved under the dedicated Settings surface;
 * this keeps old links to `/orgs/[slug]/webhooks` working.
 */
export default function LegacyWebhooksRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/settings/webhooks`);
}
