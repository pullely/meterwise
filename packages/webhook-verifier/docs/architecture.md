# webhook-verifier — architecture

A `turbo-package` component: TypeScript built by the turbo pipeline
from `packages/webhook-verifier`.

## Boundaries

A library, not a runtime: it holds no credentials, opens no connections,
and is consumed at build time by the components that depend on it.
