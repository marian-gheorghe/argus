import { describe, expect, test } from "bun:test";
import {
  ClawhipWebhookEvent,
  GateDecision,
  GatePending,
  Severity,
  TelegramCallbackPayload,
} from "../src/schemas.ts";

// --- Severity --------------------------------------------------------------

describe("Severity", () => {
  test("accepts each known value", () => {
    for (const v of ["info", "warn", "page", "critical"] as const) {
      expect(Severity.safeParse(v).success).toBe(true);
    }
  });

  test("rejects unknown value", () => {
    const r = Severity.safeParse("blah");
    expect(r.success).toBe(false);
  });
});

// --- ClawhipWebhookEvent ---------------------------------------------------

const validClawhip = {
  event_id: "evt_abc123",
  event: "gate.pending",
  severity: "info" as const,
  message: "Gate 1 — PRD approval",
  run_id: "2026-05-03-payment-svc-a3f81c2",
  gate_id: "gate_1",
  summary: "Stripe payment service.",
  key_decisions: ["Stripe SDK v15", "Postgres + Redis"],
  artifact_path: "/Users/x/.claude/omc/runs/.../prd.md",
  diff_url: "https://github.com/x/y/pull/1.diff",
  timeout_at: "2026-05-04T07:30:00Z",
};

describe("ClawhipWebhookEvent", () => {
  test("accepts well-formed payload", () => {
    const r = ClawhipWebhookEvent.safeParse(validClawhip);
    expect(r.success).toBe(true);
  });

  test("accepts a minimal payload (only required fields)", () => {
    const r = ClawhipWebhookEvent.safeParse({
      event_id: "x",
      event: "agent.failed",
      severity: "warn",
      message: "boom",
    });
    expect(r.success).toBe(true);
  });

  test("rejects missing event_id (path)", () => {
    const { event_id: _omit, ...rest } = validClawhip;
    const r = ClawhipWebhookEvent.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "event_id")).toBe(true);
    }
  });

  test("rejects empty event_id (dedup-critical)", () => {
    const r = ClawhipWebhookEvent.safeParse({ ...validClawhip, event_id: "" });
    expect(r.success).toBe(false);
  });

  test("rejects unknown severity", () => {
    const r = ClawhipWebhookEvent.safeParse({ ...validClawhip, severity: "blah" });
    expect(r.success).toBe(false);
  });

  test("rejects non-URL diff_url", () => {
    const r = ClawhipWebhookEvent.safeParse({ ...validClawhip, diff_url: "not-a-url" });
    expect(r.success).toBe(false);
  });

  test("rejects non-ISO timeout_at", () => {
    const r = ClawhipWebhookEvent.safeParse({ ...validClawhip, timeout_at: "tomorrow" });
    expect(r.success).toBe(false);
  });

  test("passthrough: keeps unknown extra fields", () => {
    const r = ClawhipWebhookEvent.safeParse({
      ...validClawhip,
      future_field: "future-value",
      another: { nested: 1 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // passthrough preserves the unknown fields on the parsed object
      expect((r.data as Record<string, unknown>).future_field).toBe("future-value");
    }
  });

  test("type round-trip compiles + matches", () => {
    const v = ClawhipWebhookEvent.parse(validClawhip);
    // Strict TS: assignability check at compile time + structural at runtime.
    const evtId: string = v.event_id;
    expect(evtId).toBe("evt_abc123");
  });
});

// --- TelegramCallbackPayload ----------------------------------------------

const validCallback = {
  callback_query: {
    id: "cbq_1",
    from: { id: 4242, username: "operator" },
    message: { chat: { id: -100123 }, message_id: 17 },
    data: "gate_1:approve",
  },
};

describe("TelegramCallbackPayload", () => {
  test("accepts well-formed callback", () => {
    const r = TelegramCallbackPayload.safeParse(validCallback);
    expect(r.success).toBe(true);
  });

  test("accepts callback without optional username", () => {
    const r = TelegramCallbackPayload.safeParse({
      callback_query: {
        ...validCallback.callback_query,
        from: { id: 4242 },
      },
    });
    expect(r.success).toBe(true);
  });

  test("rejects missing callback_query.data", () => {
    const r = TelegramCallbackPayload.safeParse({
      callback_query: {
        id: "cbq_1",
        from: { id: 4242 },
        message: { chat: { id: 1 }, message_id: 1 },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "callback_query.data")).toBe(true);
    }
  });

  test("rejects non-numeric chat.id", () => {
    const r = TelegramCallbackPayload.safeParse({
      callback_query: {
        ...validCallback.callback_query,
        message: { chat: { id: "abc" }, message_id: 1 },
      },
    });
    expect(r.success).toBe(false);
  });

  test("type round-trip", () => {
    const v = TelegramCallbackPayload.parse(validCallback);
    const data: string = v.callback_query.data;
    expect(data).toBe("gate_1:approve");
  });
});

// --- GatePending -----------------------------------------------------------

const validPending = {
  gate_id: "gate_1",
  run_id: "run_abc",
  type: "PRD" as const,
  title: "Gate 1 — PRD approval",
  summary: "Stripe payment service.",
  key_decisions: ["Stripe SDK v15"],
  artifact_path: "/tmp/prd.md",
  diff_url: "https://example.com/diff",
  created_at: "2026-05-03T07:00:00Z",
  timeout_at: "2026-05-04T07:00:00Z",
};

describe("GatePending", () => {
  test("accepts well-formed payload", () => {
    const r = GatePending.safeParse(validPending);
    expect(r.success).toBe(true);
  });

  test("rejects missing gate_id", () => {
    const { gate_id: _omit, ...rest } = validPending;
    const r = GatePending.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "gate_id")).toBe(true);
    }
  });

  test("rejects unknown type enum", () => {
    const r = GatePending.safeParse({ ...validPending, type: "bogus" });
    expect(r.success).toBe(false);
  });

  test("rejects non-ISO created_at", () => {
    const r = GatePending.safeParse({ ...validPending, created_at: "yesterday" });
    expect(r.success).toBe(false);
  });

  test("rejects non-URL diff_url", () => {
    const r = GatePending.safeParse({ ...validPending, diff_url: "nope" });
    expect(r.success).toBe(false);
  });

  test("key_decisions defaults to [] when omitted", () => {
    const { key_decisions: _omit, ...rest } = validPending;
    const r = GatePending.safeParse(rest);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.key_decisions).toEqual([]);
  });

  test("type round-trip", () => {
    const v = GatePending.parse(validPending);
    const t: "PRD" | "code-review" | "final-integration" = v.type;
    expect(t).toBe("PRD");
  });
});

// --- GateDecision ----------------------------------------------------------

const validDecision = {
  gate_id: "gate_1",
  run_id: "run_abc",
  decision: "approved" as const,
  comment: "lgtm",
  decided_at: "2026-05-03T08:00:00Z",
  decided_by_chat_id: -100123,
};

describe("GateDecision", () => {
  test("accepts well-formed payload", () => {
    const r = GateDecision.safeParse(validDecision);
    expect(r.success).toBe(true);
  });

  test("accepts minimal payload (no comment, no chat id)", () => {
    const r = GateDecision.safeParse({
      gate_id: "g",
      run_id: "r",
      decision: "rejected",
      decided_at: "2026-05-03T08:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  test("rejects unknown decision enum", () => {
    const r = GateDecision.safeParse({ ...validDecision, decision: "maybe" });
    expect(r.success).toBe(false);
  });

  test("rejects missing decided_at", () => {
    const { decided_at: _omit, ...rest } = validDecision;
    const r = GateDecision.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "decided_at")).toBe(true);
    }
  });

  test("rejects non-ISO decided_at", () => {
    const r = GateDecision.safeParse({ ...validDecision, decided_at: "soon" });
    expect(r.success).toBe(false);
  });

  test("type round-trip", () => {
    const v = GateDecision.parse(validDecision);
    const d: "approved" | "rejected" | "deferred" = v.decision;
    expect(d).toBe("approved");
  });
});
