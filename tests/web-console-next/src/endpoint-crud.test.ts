import {
  validateEndpointUrl,
  validateName,
  validateDescription,
  validateDisabledReason,
  buildUpdatePatch,
  confirmDeleteMatches,
  generateIdempotencyKey,
  NAME_MAX,
  DESCRIPTION_MAX,
  DISABLED_REASON_MAX,
} from "@web-console-next/components/webhooks/endpoint-crud";

describe("validateEndpointUrl", () => {
  it("rejects empty / whitespace-only", () => {
    expect(validateEndpointUrl("").ok).toBe(false);
    expect(validateEndpointUrl("   ").ok).toBe(false);
  });

  it("rejects unparseable strings", () => {
    expect(validateEndpointUrl("not a url").ok).toBe(false);
    expect(validateEndpointUrl("example.com").ok).toBe(false);
  });

  it("rejects non-http(s) protocols (ftp, ws, file, javascript)", () => {
    expect(validateEndpointUrl("ftp://example.com/x").ok).toBe(false);
    expect(validateEndpointUrl("ws://example.com/x").ok).toBe(false);
    expect(validateEndpointUrl("file:///tmp/x").ok).toBe(false);
    expect(validateEndpointUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("accepts http and https URLs with hostnames", () => {
    expect(validateEndpointUrl("http://example.com/hook").ok).toBe(true);
    expect(validateEndpointUrl("https://example.com/hook").ok).toBe(true);
    expect(validateEndpointUrl("https://hooks.example.com:8443/v1/whk").ok).toBe(true);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(validateEndpointUrl("  https://example.com/hook  ").ok).toBe(true);
  });

  it("returns user-readable messages (no zod codes)", () => {
    const r = validateEndpointUrl("not a url");
    expect(r.ok).toBe(false);
    expect(typeof r.message).toBe("string");
    expect(r.message).not.toMatch(/^[A-Z_]+$/); // not a zod-like enum
  });
});

describe("validateName / validateDescription / validateDisabledReason", () => {
  it("treats empty as valid (optional fields)", () => {
    expect(validateName("").ok).toBe(true);
    expect(validateDescription("").ok).toBe(true);
    expect(validateDisabledReason("").ok).toBe(true);
  });

  it("rejects strings exceeding the bound", () => {
    expect(validateName("a".repeat(NAME_MAX + 1)).ok).toBe(false);
    expect(validateDescription("a".repeat(DESCRIPTION_MAX + 1)).ok).toBe(false);
    expect(validateDisabledReason("a".repeat(DISABLED_REASON_MAX + 1)).ok).toBe(false);
  });

  it("accepts strings at the upper bound", () => {
    expect(validateName("a".repeat(NAME_MAX)).ok).toBe(true);
    expect(validateDescription("a".repeat(DESCRIPTION_MAX)).ok).toBe(true);
    expect(validateDisabledReason("a".repeat(DISABLED_REASON_MAX)).ok).toBe(true);
  });
});

describe("buildUpdatePatch", () => {
  const current = {
    url: "https://example.com/hook",
    name: "Receiver",
    description: "Initial description",
  };

  it("returns null when nothing changed", () => {
    expect(
      buildUpdatePatch(current, {
        url: "https://example.com/hook",
        name: "Receiver",
        description: "Initial description",
      }),
    ).toBeNull();
  });

  it("emits only the fields that actually changed (URL only)", () => {
    const p = buildUpdatePatch(current, {
      url: "https://new.example.com/hook",
      name: "Receiver",
      description: "Initial description",
    });
    expect(p).toEqual({ url: "https://new.example.com/hook" });
  });

  it("collapses cleared name to null (not empty string)", () => {
    const p = buildUpdatePatch(current, {
      url: current.url,
      name: "",
      description: current.description,
    });
    expect(p).toEqual({ name: null });
  });

  it("collapses cleared description to null", () => {
    const p = buildUpdatePatch(current, {
      url: current.url,
      name: current.name,
      description: "  ",
    });
    expect(p).toEqual({ description: null });
  });

  it("trims values before comparison so whitespace-only edits are no-ops", () => {
    const p = buildUpdatePatch(current, {
      url: "  https://example.com/hook  ",
      name: " Receiver ",
      description: " Initial description ",
    });
    expect(p).toBeNull();
  });

  it("does not include a `url` field when only labels change", () => {
    const p = buildUpdatePatch(current, {
      url: current.url,
      name: "Renamed",
      description: current.description,
    });
    expect(p).toEqual({ name: "Renamed" });
    expect(p && "url" in p).toBe(false);
  });
});

describe("confirmDeleteMatches", () => {
  const url = "https://hooks.example.com/v1/whk";

  it("rejects when typed value differs", () => {
    expect(confirmDeleteMatches("https://hooks.example.com/v1/wh", url)).toBe(false);
    expect(confirmDeleteMatches("HTTPS://HOOKS.EXAMPLE.COM/V1/WHK", url)).toBe(false);
  });

  it("accepts exact match (with surrounding whitespace tolerated)", () => {
    expect(confirmDeleteMatches(url, url)).toBe(true);
    expect(confirmDeleteMatches(`  ${url}  `, url)).toBe(true);
  });

  it("rejects empty typed value or empty expected URL", () => {
    expect(confirmDeleteMatches("", url)).toBe(false);
    expect(confirmDeleteMatches(url, "")).toBe(false);
  });
});

describe("generateIdempotencyKey", () => {
  it("returns a non-empty string", () => {
    const k = generateIdempotencyKey();
    expect(typeof k).toBe("string");
    expect(k.length).toBeGreaterThan(0);
  });

  it("returns distinct values across repeated calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) seen.add(generateIdempotencyKey());
    expect(seen.size).toBe(32);
  });

  it("does NOT inline raw Math.random() — fallback shape is documented", () => {
    // Force the fallback path by stubbing crypto.randomUUID away.
    const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } | undefined };
    const originalCrypto = g.crypto;
    g.crypto = {};
    try {
      const k = generateIdempotencyKey();
      // Fallback shape: idem-<base36 ts>-<base36 rand>
      expect(k.startsWith("idem-")).toBe(true);
      expect(k.split("-").length).toBe(3);
    } finally {
      g.crypto = originalCrypto;
    }
  });

  it("prefers crypto.randomUUID when available", () => {
    const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } | undefined };
    const originalCrypto = g.crypto;
    let calls = 0;
    g.crypto = {
      randomUUID: () => {
        calls += 1;
        return "00000000-0000-0000-0000-000000000001";
      },
    };
    try {
      const k = generateIdempotencyKey();
      expect(k).toBe("00000000-0000-0000-0000-000000000001");
      expect(calls).toBe(1);
    } finally {
      g.crypto = originalCrypto;
    }
  });
});
