import {
  nextRotateState,
  formatGraceDuration,
  formatGraceWindow,
  type RotateState,
} from "@web-console-next/components/webhooks/rotate-flow";

describe("rotate-flow state machine", () => {
  it("starts in idle phase", () => {
    const s: RotateState = { phase: "idle" };
    expect(s.phase).toBe("idle");
  });

  describe("rotate-confirm gating", () => {
    it("ignores confirmRotate from idle (no rotate without explicit open)", () => {
      const s = nextRotateState({ phase: "idle" }, { type: "confirmRotate" });
      // confirmRotate from idle is not honored — must go through openConfirm
      expect(s.phase).toBe("idle");
    });

    it("ignores rotateSucceeded from idle (no reveal without rotating)", () => {
      const s = nextRotateState(
        { phase: "idle" },
        {
          type: "rotateSucceeded",
          secret: "whsec_deadbeefdeadbeefdeadbeefdeadbeef",
          previousSecretExpiresAt: null,
          gracePeriodSeconds: 86400,
        },
      );
      expect(s.phase).toBe("idle");
      expect("secret" in s).toBe(false);
    });

    it("requires openConfirm → confirmRotate to enter rotating", () => {
      const opened = nextRotateState({ phase: "idle" }, { type: "openConfirm" });
      expect(opened.phase).toBe("confirming");
      const rotating = nextRotateState(opened, { type: "confirmRotate" });
      expect(rotating.phase).toBe("rotating");
    });

    it("cancelConfirm returns to idle without leaking any field", () => {
      const opened = nextRotateState({ phase: "idle" }, { type: "openConfirm" });
      const cancelled = nextRotateState(opened, { type: "cancelConfirm" });
      expect(cancelled.phase).toBe("idle");
      expect(JSON.stringify(cancelled)).toBe('{"phase":"idle"}');
    });
  });

  describe("reveal-once invariant", () => {
    function rotated(secret: string | undefined): RotateState {
      const a = nextRotateState({ phase: "idle" }, { type: "openConfirm" });
      const b = nextRotateState(a, { type: "confirmRotate" });
      return nextRotateState(b, {
        type: "rotateSucceeded",
        secret,
        previousSecretExpiresAt: "2026-02-01T00:00:00Z",
        gracePeriodSeconds: 86400,
      });
    }

    it("places the secret only on the revealing state", () => {
      const s = rotated("whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(s.phase).toBe("revealing");
      if (s.phase === "revealing") {
        expect(s.secret).toBe("whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        expect(s.gracePeriodSeconds).toBe(86400);
      }
    });

    it("closeReveal drops the secret from the active state", () => {
      const revealing = rotated("whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      const closed = nextRotateState(revealing, { type: "closeReveal" });
      expect(closed.phase).toBe("idle");
      // Serializing the new state must not contain `whsec_` anywhere — no
      // residual secret can survive in the active state object.
      expect(JSON.stringify(closed).includes("whsec_")).toBe(false);
      expect("secret" in closed).toBe(false);
    });

    it("treats undefined secret (legacy no-key) as null, not a placeholder", () => {
      const s = rotated(undefined);
      expect(s.phase).toBe("revealing");
      if (s.phase === "revealing") {
        expect(s.secret).toBeNull();
      }
    });

    it("ignores spurious closeReveal from non-revealing phases", () => {
      const idle = nextRotateState({ phase: "idle" }, { type: "closeReveal" });
      expect(idle.phase).toBe("idle");
      const confirming = nextRotateState({ phase: "confirming" }, { type: "closeReveal" });
      expect(confirming.phase).toBe("confirming");
    });
  });

  describe("rotateFailed", () => {
    it("returns from rotating to idle on failure", () => {
      const a = nextRotateState({ phase: "idle" }, { type: "openConfirm" });
      const b = nextRotateState(a, { type: "confirmRotate" });
      const failed = nextRotateState(b, { type: "rotateFailed" });
      expect(failed.phase).toBe("idle");
      expect(JSON.stringify(failed).includes("whsec_")).toBe(false);
    });
  });
});

describe("formatGraceDuration", () => {
  it("renders 0 / negative as no grace window", () => {
    expect(formatGraceDuration(0)).toBe("no grace window");
    expect(formatGraceDuration(-5)).toBe("no grace window");
  });

  it("renders the canonical 86400 (24h) value", () => {
    expect(formatGraceDuration(86400)).toBe("24 hours");
  });

  it("renders multi-day", () => {
    expect(formatGraceDuration(86400 * 3)).toBe("3 days");
    expect(formatGraceDuration(86400 * 2 + 3600 * 5)).toBe("2d 5h");
  });

  it("renders sub-day", () => {
    expect(formatGraceDuration(3600)).toBe("1h");
    expect(formatGraceDuration(3600 + 1800)).toBe("1h 30m");
    expect(formatGraceDuration(120)).toBe("2m");
    expect(formatGraceDuration(45)).toBe("45s");
  });
});

describe("formatGraceWindow", () => {
  it("returns null when previousSecretExpiresAt is null", () => {
    expect(formatGraceWindow(null, 86400)).toBeNull();
  });

  it("returns null when timestamp is unparseable", () => {
    expect(formatGraceWindow("not-a-date", 86400)).toBeNull();
  });

  it("renders absolute + relative for a future timestamp", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const target = "2026-01-16T10:00:00Z";
    const out = formatGraceWindow(target, 86400, now);
    expect(out).not.toBeNull();
    if (out) {
      expect(out.relative).toBe("in ~24 hours");
      expect(out.absolute.length).toBeGreaterThan(0);
    }
  });

  it("renders 'expired' for past timestamps", () => {
    const now = new Date("2026-01-20T00:00:00Z");
    const out = formatGraceWindow("2026-01-15T00:00:00Z", 86400, now);
    expect(out?.relative).toBe("expired");
  });
});
