// OpenNext Cloudflare adapter config for @saas/web-console-next.
//
// The orun `cloudflare-pages-turbo` component only consumes the assets
// directory the adapter emits (`.open-next/assets/**`) — it does NOT bind
// R2, KV, or D1 to this app. So we use the in-memory "dummy" overrides for
// the incremental cache, tag cache, and queue. This keeps the build hermetic
// and the per-env Pages projects (meterwise-web-console-next-{dev,stage,prod})
// publishable without any extra Cloudflare resources beyond the Pages project
// the component already provisions.
import { defineCloudflareConfig } from "@opennextjs/cloudflare/config";

export default defineCloudflareConfig({});
