import { redirect } from "next/navigation";

export default function ProjectRoot({
  params,
}: {
  params: { orgSlug: string; projectSlug: string };
}) {
  redirect(`/orgs/${params.orgSlug}/projects/${params.projectSlug}/environments`);
}
