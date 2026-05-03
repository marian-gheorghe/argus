import type { Logger } from "pino";
import type { Check, CheckResult } from "./check.ts";
import type { Escalator } from "./escalation.ts";

/**
 * Watchdog run loop.
 *
 * Tick semantics:
 *   1. For each registered check, call `check()` in parallel.
 *      Per-check exceptions are captured and reported as `{healthy:false}` —
 *      one buggy check cannot kill the watchdog.
 *   2. For each result:
 *      - If healthy: reset that check's failure counter to 0.
 *      - If unhealthy: increment the counter.
 *   3. For each unhealthy check, ask the Escalator to escalate. The Escalator
 *      decides between throttle / restart / dead-man.
 *      - On `restarted`: reset the counter (we trust the restart took effect).
 *      - On `dead-man`: leave the counter as-is (the next tick will re-evaluate;
 *        the cooldown in the Escalator prevents spam).
 *      - On `throttled`: leave the counter as-is.
 *   4. Call `sdNotify()` once per tick. We don't try to be clever about
 *      "only notify when everything is fine" — systemd's watchdog protocol
 *      only cares that THE WATCHDOG ITSELF is alive. If the watchdog ticks
 *      successfully — even when its checks are flapping — that's the signal.
 *
 * Run loop semantics:
 *   - Tick → wait `intervalMs` (interruptible by the abort signal) → tick.
 *   - On signal abort: return cleanly from `run()` after the current sleep.
 */

export interface RunnerDeps {
  checks: Check[];
  escalator: Escalator;
  log: Logger;
  signal: AbortSignal;
  /** Default 30s. */
  intervalMs?: number;
  /** Default 2. After this many consecutive unhealthy ticks, escalate. */
  consecutiveFailureThreshold?: number;
  /** Linux: ping systemd's hardware watchdog. Default no-op. */
  sdNotify?: () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_THRESHOLD = 2;

export class Runner {
  private readonly checks: Check[];
  private readonly escalator: Escalator;
  private readonly log: Logger;
  private readonly signal: AbortSignal;
  private readonly intervalMs: number;
  private readonly threshold: number;
  private readonly sdNotify: () => void;
  private readonly failureCounters = new Map<string, number>();

  constructor(deps: RunnerDeps) {
    this.checks = deps.checks;
    this.escalator = deps.escalator;
    this.log = deps.log;
    this.signal = deps.signal;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.threshold = deps.consecutiveFailureThreshold ?? DEFAULT_THRESHOLD;
    this.sdNotify = deps.sdNotify ?? (() => undefined);
  }

  /**
   * One pass over all checks. Returns nothing — observable side effects:
   *   - per-check failure counters updated
   *   - escalator invoked for every unhealthy check
   *   - sdNotify called exactly once at the end
   *
   * NEVER throws — per-check failures are caught and folded into the result
   * shape so the run loop stays alive.
   */
  async tick(): Promise<void> {
    const results = await Promise.all(this.checks.map((c) => this.runOneCheck(c)));

    for (const { check, result } of results) {
      const counter = this.failureCounters.get(check.name) ?? 0;
      if (result.healthy) {
        if (counter !== 0) {
          this.log.info(
            { check: check.name, prior_failures: counter, detail: result.detail },
            "check recovered",
          );
        }
        this.failureCounters.set(check.name, 0);
        continue;
      }

      const newCounter = counter + 1;
      this.failureCounters.set(check.name, newCounter);
      this.log.warn(
        {
          check: check.name,
          failures: newCounter,
          threshold: this.threshold,
          detail: result.detail,
        },
        "check unhealthy",
      );

      try {
        const escalation = await this.escalator.escalate(check, newCounter, this.threshold);
        if (escalation.action === "restarted") {
          // Trust the restart — reset the counter so the next failure starts a
          // fresh consecutive-failure run rather than immediately re-escalating.
          this.failureCounters.set(check.name, 0);
        }
        this.log.info(
          { check: check.name, action: escalation.action, detail: escalation.detail },
          "escalation decision",
        );
      } catch (e) {
        // Escalator should never throw, but be defensive.
        const msg = e instanceof Error ? e.message : String(e);
        this.log.error({ check: check.name, err: msg }, "escalator threw (bug)");
      }
    }

    // Liveness signal AFTER the tick completes. systemd's WatchdogSec measures
    // the gap between sd_notify pings; ticking-and-then-pinging is the clean
    // semantic ("we got around the loop").
    try {
      this.sdNotify();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn({ err: msg }, "sdNotify threw (ignored)");
    }
  }

  /**
   * Run forever (or until `signal` aborts). On exit (signal aborted), returns
   * cleanly so callers can `await runner.run()` then close other resources.
   */
  async run(): Promise<void> {
    this.log.info(
      {
        interval_ms: this.intervalMs,
        threshold: this.threshold,
        checks: this.checks.map((c) => c.name),
      },
      "watchdog runner starting",
    );
    while (!this.signal.aborted) {
      try {
        await this.tick();
      } catch (e) {
        // Last-resort: tick should never throw, but if it does, log + continue
        // so the watchdog itself doesn't die.
        const msg = e instanceof Error ? e.message : String(e);
        this.log.error({ err: msg }, "tick threw (bug); continuing");
      }
      if (this.signal.aborted) break;
      await this.sleep(this.intervalMs);
    }
    this.log.info("watchdog runner stopping (signal aborted)");
  }

  private async runOneCheck(check: Check): Promise<{ check: Check; result: CheckResult }> {
    try {
      const result = await check.check();
      return { check, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        check,
        result: { healthy: false, detail: `check threw: ${msg}` },
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.signal.aborted) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        this.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        this.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
