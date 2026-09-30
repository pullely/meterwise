// Rule 1 (design §7.4): the customer's provider key is read in exactly ONE
// function, forwardHeaders(), which builds the upstream request's headers from
// an allow-list. Nothing else in this Worker reads `authorization`
// (tests/proxy-worker scans the source to keep it that way). Every
// `x-meterwise-*` header, cookies and anything not listed are dropped.

const FORWARDED = ["authorization", "content-type", "openai-organization", "openai-project", "accept"] as const;

export function forwardHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value !== null) out.set(name, value);
  }
  // The body is re-serialised JSON, whatever the caller declared.
  out.set("content-type", "application/json");
  return out;
}

// The provider's response headers the caller gets back: content type, the
// provider's own rate-limit and timing headers, and `x-mock-*` (sent only by
// the stage mock upstream; the real provider never does). Nothing else — in
// particular no set-cookie.
const RETURNED = /^(content-type|cache-control|openai-processing-ms|openai-version|x-ratelimit-[a-z-]+|x-mock-[a-z0-9-]+)$/;

export function returnedHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (RETURNED.test(name)) out.set(name, value);
  });
  return out;
}
