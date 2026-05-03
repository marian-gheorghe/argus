import type { Logger } from "pino";
import pino from "pino";
import type { Check } from "./check.ts";
import { BridgeCheck } from "./checks/bridge.ts";
import { ClawhipCheck } from "./checks/clawhip.ts";
import { OmcWaitCheck } from "./checks/omc-wait.ts";
import { PendingRepliesCheck } from "./checks/pending-replies.ts";
import { Escalator, OMCNativeCallbackDeadMan } from "./escalation.ts";
import { detectPlatform, makeServiceManager } from "./platform.ts";
import { Runner } from "./runner.ts";

/**
 * Main entrypoint. Wires production deps from environment and runs the
 * watchdog loop until SIGTERM/SIGINT.
 *
 * Env knobs:
 *   - BRIDGE_QUEUE_DB_PATH (default $HOME/.argus/state/bridge-queue.sqlite)
 *   - LOG_LEVEL            (default info; pino-pretty in dev, JSON in prod)
 *   - WATCHDOG_INTERVAL_MS (default 30000)
 *   - WATCHDOG_THRESHOLD   (default 2)
 *   - WATCHDOG_RESTART_COOLDOWN_MS (default 60000)
 *   - WATCHDOG_PENDING_REPLIES_OLDER_THAN_SECS (default 7200)
 *   - WATCHDOG_USE_SD_NOTIFY (default true on Linux, false on Mac)
 */

export function makeLog(): Logger {
  const level = process.env.LOG_LEVEL ?? "info";
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l" },
      },
    });
  }
  return pino({ level });
}

/**
 * Linux sd_notify(WATCHDOG=1) implementation. Writes a single datagram to the
 * UNIX socket pointed at by `$NOTIFY_SOCKET`, which systemd sets when it
 * spawns a unit with `Type=notify`. On macOS or when `$NOTIFY_SOCKET` is
 * absent, returns a no-op.
 *
 * We use a UDP-style write via `Bun.udpSocket` (or Node's `dgram`-equivalent
 * — Bun supports both). To avoid pulling in an extra dep, we implement the
 * socket via Bun's `fetch`-like API for unix-domain sockets… which doesn't
 * exist. So we shell out to `systemd-notify --ready=0 WATCHDOG=1` instead;
 * marginally slower but spawn happens at most every interval (30s by
 * default), so it's fine.
 *
 * If `systemd-notify` is missing (e.g. cut-down container), we silently
 * fall back to a no-op so the watchdog still functions on hosts where the
 * sd_notify channel doesn't exist.
 */
export function makeSdNotify(): () => void {
  if (process.platform !== "linux") return () => undefined;
  if (!process.env.NOTIFY_SOCKET) return () => undefined;
  let disabled = false;
  return () => {
    if (disabled) return;
    try {
      const proc = Bun.spawn(["systemd-notify", "WATCHDOG=1"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      // Don't await — fire-and-forget. systemd-notify exits quickly.
      void proc.exited;
    } catch {
      // ENOENT or similar — disable for the rest of the process lifetime
      // so we don't spam errors on a container without systemd-notify.
      disabled = true;
    }
  };
}

export interface BuildArgs {
  env: Record<string, string | undefined>;
  log: Logger;
  signal: AbortSignal;
}

export interface BuiltRunner {
  runner: Runner;
  checks: Check[];
}

/**
 * Build a Runner from environment variables. Exposed for tests + integration
 * smoke; the production main() below wraps it with signal handling + exit.
 */
export function build(args: BuildArgs): BuiltRunner {
  const { env, log, signal } = args;
  const platform = detectPlatform();
  const serviceManager = makeServiceManager(platform);

  const home = env.HOME ?? "";
  const bridgeDbPath = env.BRIDGE_QUEUE_DB_PATH ?? `${home}/.argus/state/bridge-queue.sqlite`;
  const olderThanSecs = Number(env.WATCHDOG_PENDING_REPLIES_OLDER_THAN_SECS ?? 7200);

  const checks: Check[] = [
    new ClawhipCheck({ serviceManager }),
    new BridgeCheck({ serviceManager }),
    new OmcWaitCheck({ serviceManager }),
    new PendingRepliesCheck({ dbPath: bridgeDbPath, olderThanSecs }),
  ];

  const restartCooldownMs = Number(env.WATCHDOG_RESTART_COOLDOWN_MS ?? 60_000);
  const escalator = new Escalator({
    deadman: new OMCNativeCallbackDeadMan(),
    log,
    restartCooldownMs,
  });

  const intervalMs = Number(env.WATCHDOG_INTERVAL_MS ?? 30_000);
  const threshold = Number(env.WATCHDOG_THRESHOLD ?? 2);

  const runner = new Runner({
    checks,
    escalator,
    log,
    signal,
    intervalMs,
    consecutiveFailureThreshold: threshold,
    sdNotify: makeSdNotify(),
  });

  return { runner, checks };
}

if (import.meta.main) {
  const log = makeLog();
  const ctrl = new AbortController();

  const { runner, checks } = build({ env: process.env, log, signal: ctrl.signal });
  log.info({ checks: checks.map((c) => c.name) }, "argus-watchdog booting");

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    ctrl.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await runner.run();
  log.info("clean exit");
  process.exit(0);
}
