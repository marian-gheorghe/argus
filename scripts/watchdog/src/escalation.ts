import type { Logger } from "pino";
import type { Check } from "./check.ts";
import type { SpawnFn } from "./platform.ts";

/**
 * Dead-man's-switch — the escalation path of last resort.
 *
 * When clawhip is the unhealthy daemon being escalated, we cannot route the
 * alert THROUGH clawhip itself. The dead-man bypasses clawhip and uses OMC's
 * native callback CLI (`omc emit ...`) which talks directly to the configured
 * native callback (Discord/Telegram via OMC's own bridge — independent of
 * clawhip's webhook router).
 *
 * Implementations:
 *   - OMCNativeCallbackDeadMan — production. Shells out to `omc emit`.
 *   - MockDeadMan — tests. Records calls; can be programmed to fail once.
 */

export interface DeadMan {
  emit(event: string, message: string, payload?: Record<string, unknown>): Promise<void>;
}

export class MockDeadMan implements DeadMan {
  readonly calls: { event: string; message: string; payload?: Record<string, unknown> }[] = [];
  private failNextError: string | null = null;

  failNext(err: string): void {
    this.failNextError = err;
  }

  async emit(event: string, message: string, payload?: Record<string, unknown>): Promise<void> {
    if (this.failNextError !== null) {
      const e = this.failNextError;
      this.failNextError = null;
      throw new Error(e);
    }
    this.calls.push({ event, message, payload });
  }
}

const defaultSpawn: SpawnFn = async (cmd) => {
  if (cmd.length === 0) {
    return { exitCode: -1, stderr: "empty command" };
  }
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderrText = await new Response(proc.stderr).text();
  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stderr: stderrText };
};

export interface OMCNativeCallbackDeadManOpts {
  omcBin?: string;
  spawn?: SpawnFn;
}

/**
 * Production dead-man emitter. Shells out to OMC's native callback CLI:
 *
 *   omc emit --tier critical --event <event> --message <msg> --payload-json <json>
 *
 * This bypasses clawhip entirely. OMC's native callback path uses its own
 * Discord/Telegram bridge configured at install time — see
 * `~/.claude/omc/native-callback.toml`. If THAT's also down, there's no
 * higher escalation; the watchdog logs the failure and continues.
 */
export class OMCNativeCallbackDeadMan implements DeadMan {
  private readonly omcBin: string;
  private readonly spawn: SpawnFn;

  constructor(opts?: OMCNativeCallbackDeadManOpts) {
    this.omcBin = opts?.omcBin ?? "omc";
    this.spawn = opts?.spawn ?? defaultSpawn;
  }

  async emit(event: string, message: string, payload?: Record<string, unknown>): Promise<void> {
    const cmd = [
      this.omcBin,
      "emit",
      "--tier",
      "critical",
      "--event",
      event,
      "--message",
      message,
      "--payload-json",
      JSON.stringify(payload ?? {}),
    ];
    const { exitCode, stderr } = await this.spawn(cmd);
    if (exitCode !== 0) {
      throw new Error(`omc emit exit=${exitCode}: ${stderr.trim() || "(no stderr)"}`);
    }
  }
}

export type EscalationAction = "restarted" | "dead-man" | "throttled";

export interface EscalationResult {
  action: EscalationAction;
  detail: string;
}

export interface EscalatorDeps {
  deadman: DeadMan;
  log: Logger;
  /** Minimum ms between consecutive restart attempts on the same check. */
  restartCooldownMs: number;
  /** Injectable clock for testability. */
  now?: () => number;
}

/**
 * Escalation policy.
 *
 * Inputs at each tick: (check, current consecutive-failure counter, threshold).
 * Decision tree:
 *
 *   1. counter < threshold → "throttled" (let the runner keep counting).
 *   2. counter >= threshold:
 *      a. last restart of this check was within `restartCooldownMs` →
 *         "throttled" (the previous restart hasn't had time to take effect).
 *      b. otherwise: try `check.restart()`.
 *         - On ok=true → "restarted" (and remember the restart timestamp).
 *         - On ok=false OR restart throw → emit dead-man, return "dead-man".
 *
 * The runner is responsible for clearing the failure counter once `check()`
 * returns healthy again. This module only decides what to do at the moment
 * of the unhealthy tick.
 */
export class Escalator {
  private readonly deadman: DeadMan;
  private readonly log: Logger;
  private readonly restartCooldownMs: number;
  private readonly now: () => number;
  private readonly lastRestartAt = new Map<string, number>();

  constructor(deps: EscalatorDeps) {
    this.deadman = deps.deadman;
    this.log = deps.log;
    this.restartCooldownMs = deps.restartCooldownMs;
    this.now = deps.now ?? Date.now;
  }

  async escalate(
    check: Check,
    consecutiveFailures: number,
    threshold: number,
  ): Promise<EscalationResult> {
    if (consecutiveFailures < threshold) {
      return {
        action: "throttled",
        detail: `failures=${consecutiveFailures} < threshold=${threshold}`,
      };
    }

    const last = this.lastRestartAt.get(check.name);
    const t = this.now();
    if (last !== undefined && t - last < this.restartCooldownMs) {
      const remaining = this.restartCooldownMs - (t - last);
      this.log.warn(
        { check: check.name, remaining_ms: remaining },
        "escalate: throttled by cooldown",
      );
      return {
        action: "throttled",
        detail: `cooldown active: ${remaining}ms remaining`,
      };
    }

    let restartDetail: string;
    let restartOk: boolean;
    try {
      const r = await check.restart();
      restartOk = r.ok;
      restartDetail = r.detail;
    } catch (e) {
      restartOk = false;
      restartDetail = `restart threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Stamp the attempt regardless of success — a failed restart still counts
    // toward the cooldown so we don't kickstart-spam a service that's
    // permanently broken between this tick and the next.
    this.lastRestartAt.set(check.name, t);

    if (restartOk) {
      this.log.info({ check: check.name, detail: restartDetail }, "escalate: restart succeeded");
      return { action: "restarted", detail: restartDetail };
    }

    // Restart failed → emit dead-man. The event name is derived from the
    // check name to keep clawhip routes surgical: clawhip's "dead-man" is
    // routed to CRITICAL Telegram + Discord; other checks may have their
    // own routes. We emit `<check-name>.dead-man` for that flexibility.
    const event = `${check.name}.dead-man`;
    const message = `${check.name} watchdog: restart failed (${restartDetail})`;
    const payload: Record<string, unknown> = {
      check: check.name,
      restart_detail: restartDetail,
      consecutive_failures: consecutiveFailures,
      threshold,
      timestamp: new Date(t).toISOString(),
    };

    this.log.error(
      { check: check.name, restart_detail: restartDetail, event },
      "escalate: restart failed, emitting dead-man",
    );

    try {
      await this.deadman.emit(event, message, payload);
      return {
        action: "dead-man",
        detail: `restart failed (${restartDetail}); dead-man ${event} emitted`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.fatal(
        { check: check.name, dead_man_err: msg },
        "escalate: dead-man emit failed (no further escalation path)",
      );
      // Never throw out of escalate — the runner must keep ticking.
      return {
        action: "dead-man",
        detail: `restart failed (${restartDetail}); dead-man emit failed: ${msg}`,
      };
    }
  }
}
