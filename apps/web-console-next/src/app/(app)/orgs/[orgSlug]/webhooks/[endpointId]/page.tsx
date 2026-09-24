import { redirect } from "next/navigation";

/**
 * Compatibility redirect for deep links to a specific webhook endpoint, which
 * now lives under the Settings surface.
 */
export default function LegacyWebhookEndpointRedirect({
  params,
}: {
  params: { orgSlug: string; endpointId: string };
}) {
  redirect(`/orgs/${params.orgSlug}/settings/webhooks/${params.endpointId}`);
}
