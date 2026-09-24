import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `@saas/sdk` is a workspace-source package: its `package.json` exports
  // point at `./src/index.ts` and the file uses TS NodeNext-style `./*.js`
  // import specifiers that resolve to the sibling `.ts` source. Next's
  // webpack pipeline does not perform that pairing for source-mode workspace
  // deps, so register an extension alias and run the package through SWC.
  transpilePackages: ["@saas/sdk"],
  webpack(config) {
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  // `output: "standalone"` is required by the @opennextjs/cloudflare adapter,
  // which reads `.next/standalone/**` to bundle the server function before
  // emitting Pages-compatible assets into `.open-next/assets/**`.
  output: "standalone",
  // Trace from the monorepo root so the standalone build pulls in workspace
  // dependencies (e.g. @saas/contracts) instead of trying to resolve them
  // from the per-app node_modules.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    // Lint runs separately via `pnpm lint`. Skip during `next build` to keep
    // the build deterministic across Node/ESLint flat-config quirks.
    ignoreDuringBuilds: true,
  },
  env: {
    NEXT_PUBLIC_DEPLOY_ENV: process.env.NEXT_PUBLIC_DEPLOY_ENV ?? "",
    // Solo profile OFF: a product team shares one organization and an
    // agency may run several, so the multi-tenant surfaces stay on.
    // See specs/profiles/solo-m0.md.
    NEXT_PUBLIC_SOLO_MODE: process.env.NEXT_PUBLIC_SOLO_MODE ?? "false",
  },
};

export default nextConfig;
