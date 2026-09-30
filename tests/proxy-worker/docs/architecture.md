# proxy-worker-tests

The key-custody suite of design §7.6 for `apps/proxy-worker`, run against the
stage mock upstream's own code (`apps/mock-upstream`) bound in place of the
provider, and the real `ledger-worker` router over node:sqlite. No test calls
a real provider.
