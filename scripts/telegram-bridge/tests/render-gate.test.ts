import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderGateMessage } from "../src/render-gate.ts";
import type { ClawhipWebhookEvent } from "../src/schemas.ts";

const GATES_CHAT_ID = -100777;

// Silence the renderer's console.warn for null-case tests. Restored in afterAll.
const originalWarn = console.warn;
beforeAll(() => {
  console.warn = () => {};
});
afterAll(() => {
  console.warn = originalWarn;
});

/**
 * Helper to build a `ClawhipWebhookEvent` with the gate-shaped fields the
 * renderer expects. `tier` is set by the watcher/server, not part of the
 * event itself, so we omit it here.
 */
function makeGateEvent(overrides: Partial<ClawhipWebhookEvent> = {}): ClawhipWebhookEvent {
  // Far-future timestamp so non-EXPIRED tests don't flake near year boundaries.
  const future = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return {
    event_id: "gate.pending:gate_1",
    event: "gate.pending",
    severity: "info",
    message: "Gate 1 — PRD approval",
    run_id: "argus-2026-05-03-payment",
    gate_id: "gate_1",
    summary: "Stripe-based payment service. Postgres for persistence.",
    key_decisions: ["Stripe SDK v15", "Idempotency: 24h TTL"],
    artifact_path: "$OMC_STATE_DIR/argus-2026-05-03-payment/prd.md",
    timeout_at: future,
    ...overrides,
  };
}

describe("renderGateMessage — happy path", () => {
  test("returns chat_id, text, and 3-button keyboard for a valid gate", () => {
    const out = renderGateMessage(makeGateEvent(), GATES_CHAT_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.chat_id).toBe(GATES_CHAT_ID);

    // Header line includes title and run id.
    expect(out.text).toContain("Gate 1 — PRD approval");
    expect(out.text).toContain("argus-2026-05-03-payment");

    // Section labels present.
    expect(out.text).toContain("*Summary:*");
    expect(out.text).toContain("*Key decisions:*");
    expect(out.text).toContain("*Artifact:*");
    expect(out.text).toContain("*Times out at:*");

    // Bullets for decisions.
    expect(out.text).toContain("• Stripe SDK v15");
    expect(out.text).toContain("• Idempotency: 24h TTL");

    // Inline keyboard: one row, three buttons in expected order.
    expect(out.keyboard).toBeDefined();
    if (!out.keyboard) return;
    expect(out.keyboard.inline_keyboard).toHaveLength(1);
    const row = out.keyboard.inline_keyboard[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row).toHaveLength(3);
    expect(row[0]).toEqual({ text: "✅ Approve", callback_data: "gate_1:approve" });
    expect(row[1]).toEqual({ text: "❌ Reject + comment", callback_data: "gate_1:reject" });
    expect(row[2]).toEqual({ text: "⏸ Defer 4h", callback_data: "gate_1:defer" });
  });

  test("includes diff_url when present", () => {
    const out = renderGateMessage(
      makeGateEvent({ diff_url: "https://github.com/foo/bar/pull/42" }),
      GATES_CHAT_ID,
    );
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.text).toContain("https://github.com/foo/bar/pull/42");
  });

  test("renders '(none)' when diff_url is absent", () => {
    const out = renderGateMessage(makeGateEvent(), GATES_CHAT_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.text).toContain("*Diff:* (none)");
  });

  test("empty key_decisions array → no bullet section in output", () => {
    const out = renderGateMessage(makeGateEvent({ key_decisions: [] }), GATES_CHAT_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    // Section header NOT included when there are no decisions to list.
    expect(out.text).not.toContain("*Key decisions:*");
  });

  test("undefined key_decisions treated as empty list (no section)", () => {
    const evt = makeGateEvent();
    // biome-ignore lint/performance/noDelete: explicit unset to model missing field
    delete (evt as { key_decisions?: unknown }).key_decisions;
    const out = renderGateMessage(evt, GATES_CHAT_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.text).not.toContain("*Key decisions:*");
  });
});

describe("renderGateMessage — truncation", () => {
  test("summary > 1500 chars is truncated with suffix", () => {
    const long = "x".repeat(2000);
    const out = renderGateMessage(makeGateEvent({ summary: long }), GATES_CHAT_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    // 1500 chars of content + truncation suffix.
    expect(out.text).toContain("…(truncated)");
    // The full 2000-char string should NOT appear verbatim.
    expect(out.text.includes("x".repeat(2000))).toBe(false);
    // First 1500 x's should be present.
    expect(out.text.includes("x".repeat(1500))).toBe(true);
  });

  test("summary at exactly 1500 chars is NOT truncated", () => {
    const exact = "y".repeat(1500);
    const out = renderGateMessage(makeGateEvent({ summary: exact }), GATES_CHAT_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.text).not.toContain("…(truncated)");
    expect(out.text).toContain(exact);
  });
});

describe("renderGateMessage — time formatting", () => {
  test("renders 'YYYY-MM-DD HH:MM UTC' + relative time for future timeout", () => {
    // 7h 58m from now.
    const future = new Date(Date.now() + (7 * 3600 + 58 * 60) * 1000).toISOString();
    const out = renderGateMessage(makeGateEvent({ timeout_at: future }), GATES_CHAT_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    // Should match a "YYYY-MM-DD HH:MM UTC" pattern.
    expect(out.text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    // Should mention hours+minutes relative.
    expect(out.text).toMatch(/in \d+h \d+m/);
  });

  test("past timeout_at → 'EXPIRED'", () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const out = renderGateMessage(makeGateEvent({ timeout_at: past }), GATES_CHAT_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.text).toContain("EXPIRED");
  });
});

describe("renderGateMessage — null/skip cases", () => {
  test("missing gate_id → null", () => {
    const evt = makeGateEvent();
    // biome-ignore lint/performance/noDelete: model missing required field
    delete (evt as { gate_id?: unknown }).gate_id;
    expect(renderGateMessage(evt, GATES_CHAT_ID)).toBeNull();
  });

  test("empty gate_id → null", () => {
    expect(renderGateMessage(makeGateEvent({ gate_id: "" }), GATES_CHAT_ID)).toBeNull();
  });

  test("missing summary → null", () => {
    const evt = makeGateEvent();
    // biome-ignore lint/performance/noDelete: model missing required field
    delete (evt as { summary?: unknown }).summary;
    expect(renderGateMessage(evt, GATES_CHAT_ID)).toBeNull();
  });

  test("empty summary → null", () => {
    expect(renderGateMessage(makeGateEvent({ summary: "" }), GATES_CHAT_ID)).toBeNull();
  });

  test("missing artifact_path → null", () => {
    const evt = makeGateEvent();
    // biome-ignore lint/performance/noDelete: model missing required field
    delete (evt as { artifact_path?: unknown }).artifact_path;
    expect(renderGateMessage(evt, GATES_CHAT_ID)).toBeNull();
  });

  test("empty artifact_path → null", () => {
    expect(renderGateMessage(makeGateEvent({ artifact_path: "" }), GATES_CHAT_ID)).toBeNull();
  });

  test("missing timeout_at → null", () => {
    const evt = makeGateEvent();
    // biome-ignore lint/performance/noDelete: model missing required field
    delete (evt as { timeout_at?: unknown }).timeout_at;
    expect(renderGateMessage(evt, GATES_CHAT_ID)).toBeNull();
  });

  test("unparseable timeout_at → null", () => {
    // Cast around the schema's datetime check — the renderer should defend
    // independently of upstream validation.
    const evt = makeGateEvent({ timeout_at: "not-a-date" as unknown as string });
    expect(renderGateMessage(evt, GATES_CHAT_ID)).toBeNull();
  });

  test("key_decisions not an array → null", () => {
    const evt = makeGateEvent();
    (evt as { key_decisions?: unknown }).key_decisions = "not-an-array";
    expect(renderGateMessage(evt, GATES_CHAT_ID)).toBeNull();
  });
});
