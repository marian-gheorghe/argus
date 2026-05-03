import { describe, expect, test } from "bun:test";
import pino from "pino";
import type { Check, CheckResult, RestartResult } from "../src/check.ts";
import { Escalator, MockDeadMan } from "../src/escalation.ts";
import { Runner } from "../src/runner.ts";

const silentLog = pino({ level: "silent" });

class StubCheck implements Check {
  readonly name: string;
  /** Sequence of healthy/unhealthy results to return on successive check() calls. */
  private healthQueue: boolean[];
  /** Sequence of restart ok/fail to return on successive restart() calls. */
  private restartQueue: boolean[];
  checkCalls = 0;
  restartCalls = 0;
  private throwOnNextCheck = false;

  constructor(opts: { name: string; healthQueue?: boolean[]; restartQueue?: boolean[] }) {
    this.name = opts.name;
    this.healthQueue = opts.healthQueue ?? [];
    this.restartQueue = opts.restartQueue ?? [];
  }

  setHealthSequence(q: boolean[]): void {
    this.healthQueue = q;
  }
  setRestartSequence(q: boolean[]): void {
    this.restartQueue = q;
  }
  throwNextCheck(): void {
    this.throwOnNextCheck = true;
  }

  async check(): Promise<CheckResult> {
    this.checkCalls += 1;
    if (this.throwOnNextCheck) {
      this.throwOnNextCheck = false;
      throw new Error("simulated check throw");
    }
    const next = this.healthQueue.shift() ?? true;
    return { healthy: next, detail: next ? "ok" : "down" };
  }

  async restart(): Promise<RestartResult> {
    this.restartCalls += 1;
    const next = this.restartQueue.shift() ?? true;
    return { ok: next, detail: next ? "kicked" : "restart failed" };
  }
}

function makeEscalator(deadman: MockDeadMan, now: () => number): Escalator {
  return new Escalator({ deadman, log: silentLog, restartCooldownMs: 60_000, now });
}

describe("Runner.tick", () => {
  test("all checks healthy → no escalation; sdNotify pinged", async () => {
    const a = new StubCheck({ name: "a", healthQueue: [true] });
    const b = new StubCheck({ name: "b", healthQueue: [true] });
    const dm = new MockDeadMan();
    const now = 1_000;
    const e = makeEscalator(dm, () => now);
    let pings = 0;
    const r = new Runner({
      checks: [a, b],
      escalator: e,
      log: silentLog,
      signal: new AbortController().signal,
      consecutiveFailureThreshold: 2,
      sdNotify: () => pings++,
    });
    await r.tick();
    expect(a.checkCalls).toBe(1);
    expect(b.checkCalls).toBe(1);
    expect(a.restartCalls).toBe(0);
    expect(dm.calls).toHaveLength(0);
    expect(pings).toBe(1);
  });

  test("one unhealthy below threshold → no restart; sdNotify still pinged (we are alive)", async () => {
    const a = new StubCheck({ name: "a", healthQueue: [false] });
    const dm = new MockDeadMan();
    const e = makeEscalator(dm, () => 1_000);
    let pings = 0;
    const r = new Runner({
      checks: [a],
      escalator: e,
      log: silentLog,
      signal: new AbortController().signal,
      consecutiveFailureThreshold: 2,
      sdNotify: () => pings++,
    });
    await r.tick();
    expect(a.restartCalls).toBe(0);
    expect(dm.calls).toHaveLength(0);
    // We're alive, so sdNotify pings even though a check is currently failing.
    expect(pings).toBe(1);
  });

  test("counter increments across ticks; reaches threshold → restart fires", async () => {
    const a = new StubCheck({
      name: "a",
      healthQueue: [false, false, false],
      restartQueue: [true],
    });
    const dm = new MockDeadMan();
    const e = makeEscalator(dm, () => 1_000);
    const r = new Runner({
      checks: [a],
      escalator: e,
      log: silentLog,
      signal: new AbortController().signal,
      consecutiveFailureThreshold: 2,
    });
    await r.tick(); // failure 1, throttled
    expect(a.restartCalls).toBe(0);
    await r.tick(); // failure 2 → restart
    expect(a.restartCalls).toBe(1);
    expect(dm.calls).toHaveLength(0);
  });

  test("recovery resets the counter", async () => {
    const a = new StubCheck({
      name: "a",
      healthQueue: [false, true, false, false],
      restartQueue: [true],
    });
    const dm = new MockDeadMan();
    const e = makeEscalator(dm, () => 1_000);
    const r = new Runner({
      checks: [a],
      escalator: e,
      log: silentLog,
      signal: new AbortController().signal,
      consecutiveFailureThreshold: 2,
    });
    await r.tick(); // 1 failure
    await r.tick(); // healthy → counter back to 0
    await r.tick(); // 1 failure (no restart yet, threshold = 2)
    expect(a.restartCalls).toBe(0);
    await r.tick(); // 2 failures → restart
    expect(a.restartCalls).toBe(1);
  });

  test("restart success resets the failure counter (next failure starts fresh)", async () => {
    const a = new StubCheck({
      name: "a",
      healthQueue: [false, false, false, false],
      restartQueue: [true, true],
    });
    const dm = new MockDeadMan();
    let now = 1_000;
    const e = new Escalator({
      deadman: dm,
      log: silentLog,
      restartCooldownMs: 1_000,
      now: () => now,
    });
    const r = new Runner({
      checks: [a],
      escalator: e,
      log: silentLog,
      signal: new AbortController().signal,
      consecutiveFailureThreshold: 2,
    });
    await r.tick(); // 1 failure
    await r.tick(); // 2 failures → restart succeeds, counter reset to 0
    expect(a.restartCalls).toBe(1);
    now += 5_000; // past cooldown
    await r.tick(); // 1 failure (post-reset)
    expect(a.restartCalls).toBe(1);
    await r.tick(); // 2 failures → second restart
    expect(a.restartCalls).toBe(2);
  });

  test("restart failure → dead-man emitted", async () => {
    const a = new StubCheck({
      name: "clawhip",
      healthQueue: [false, false],
      restartQueue: [false],
    });
    const dm = new MockDeadMan();
    const e = makeEscalator(dm, () => 1_000);
    const r = new Runner({
      checks: [a],
      escalator: e,
      log: silentLog,
      signal: new AbortController().signal,
      consecutiveFailureThreshold: 2,
    });
    await r.tick();
    await r.tick();
    expect(a.restartCalls).toBe(1);
    expect(dm.calls).toHaveLength(1);
    const c = dm.calls[0];
    if (!c) throw new Error("expected call");
    expect(c.event).toBe("clawhip.dead-man");
  });

  test("a check that throws does not crash the loop; treated as unhealthy for that tick", async () => {
    const a = new StubCheck({ name: "a", healthQueue: [true] });
    const b = new StubCheck({ name: "b", healthQueue: [true] });
    a.throwNextCheck();
    const dm = new MockDeadMan();
    const e = makeEscalator(dm, () => 1_000);
    let pings = 0;
    const r = new Runner({
      checks: [a, b],
      escalator: e,
      log: silentLog,
      signal: new AbortController().signal,
      consecutiveFailureThreshold: 2,
      sdNotify: () => pings++,
    });
    // Should resolve, not throw.
    await r.tick();
    expect(b.checkCalls).toBe(1);
    // a's failure counter should be 1 (a threw, treated as unhealthy).
    // pings still happens (we are alive even if one check is sick).
    expect(pings).toBe(1);
  });

  test("sdNotify is optional (no-op default)", async () => {
    const a = new StubCheck({ name: "a", healthQueue: [true] });
    const dm = new MockDeadMan();
    const e = makeEscalator(dm, () => 1_000);
    const r = new Runner({
      checks: [a],
      escalator: e,
      log: silentLog,
      signal: new AbortController().signal,
      consecutiveFailureThreshold: 2,
    });
    await r.tick(); // shouldn't throw despite no sdNotify
    expect(a.checkCalls).toBe(1);
  });
});

describe("Runner.run", () => {
  test("aborts within intervalMs of signal abort", async () => {
    const a = new StubCheck({ name: "a", healthQueue: [true, true, true, true] });
    const dm = new MockDeadMan();
    const e = makeEscalator(dm, () => 1_000);
    const ctrl = new AbortController();
    const r = new Runner({
      checks: [a],
      escalator: e,
      log: silentLog,
      signal: ctrl.signal,
      intervalMs: 30,
      consecutiveFailureThreshold: 2,
    });
    const p = r.run();
    setTimeout(() => ctrl.abort(), 50);
    const start = Date.now();
    await p;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  test("ticks at least once and at most a few times within the window", async () => {
    const a = new StubCheck({ name: "a", healthQueue: Array(20).fill(true) });
    const dm = new MockDeadMan();
    const e = makeEscalator(dm, () => 1_000);
    const ctrl = new AbortController();
    const r = new Runner({
      checks: [a],
      escalator: e,
      log: silentLog,
      signal: ctrl.signal,
      intervalMs: 20,
      consecutiveFailureThreshold: 2,
    });
    setTimeout(() => ctrl.abort(), 100);
    await r.run();
    expect(a.checkCalls).toBeGreaterThanOrEqual(1);
    expect(a.checkCalls).toBeLessThan(20);
  });
});
