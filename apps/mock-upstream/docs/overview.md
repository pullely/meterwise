# mock-upstream — overview

A STAGE-ONLY stand-in for OpenAI's `POST /v1/chat/completions`, bound to
proxy-worker's stage deployment as `UPSTREAM_OVERRIDE` so no smoke or test
calls a real provider. Deterministic usage (1,000 prompt / 500 completion
tokens), a dated model snapshot in the answer, `mock-error-401`,
`mock-error-500` and `mock-disconnect` models for the error paths. It reports
the header names it received and a SHA-256 of `Authorization`, never a
header value. No prod environment, no bindings, no public hostname.
