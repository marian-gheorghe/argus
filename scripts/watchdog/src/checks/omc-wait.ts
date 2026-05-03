import type { Check, CheckResult, RestartResult } from "../check.ts";
import type { ServiceManager, SpawnFn } from "../platform.ts";

/**
 * `omc wait` health check.
 *
 * Why pgrep instead of HTTP: `omc wait` is a long-running CLI subcommand
 * that blocks until OMC's wait queue advances; it does not expose a health
 * port. We probe its existence in the process table via `pgrep -f "omc wait"`.
 * pgrep exit codes:
 *   0 = matched at least one process (healthy)
 *   1 = no matches (unhealthy — daemon not running)
 *   2 = syntax error / system error (unhealthy with stderr)
 *
 * False-positive risk: `pgrep -f "omc wait"` would also match `cat omc wait.log`
 * or similar incidental command lines. In practice this is fine:
 *   - The watchdog runs in a known environment (the user's shell session under
 *     launchd/systemd) where stray "omc wait" matches don't realistically appear.
 *   - The fallback if a stray match keeps us "healthy" while the real `omc wait`
 *     daemon is dead is graceful — `omc team` invocations would error, the
 *     operator notices via clawhip/Telegram, restarts manually. Not silent.
 *
 * Restart action: bounce `com.argus.omc-wait`.
 */

const DEFAULT_LABEL = "com.argus.omc-wait";

export interface OmcWaitCheckDeps {
  serviceManager: ServiceManager;
  spawn?: SpawnFn;
  serviceLabel?: string;
  pgrepPattern?: string;
}

const defaultSpawn: SpawnFn = async (cmd) => {
  if (cmd.length === 0) {
    return { exitCode: -1, stderr: "empty command" };
  }
  const proc = Bun.spawn(cmd, {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrText = await new Response(proc.stderr).text();
  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stderr: stderrText };
};

export class OmcWaitCheck implements Check {
  readonly name = "omc-wait";
  private readonly spawn: SpawnFn;
  private readonly serviceLabel: string;
  private readonly pgrepPattern: string;
  private readonly serviceManager: ServiceManager;

  constructor(deps: OmcWaitCheckDeps) {
    this.serviceManager = deps.serviceManager;
    this.spawn = deps.spawn ?? defaultSpawn;
    this.serviceLabel = deps.serviceLabel ?? DEFAULT_LABEL;
    this.pgrepPattern = deps.pgrepPattern ?? "omc wait";
  }

  async check(): Promise<CheckResult> {
    const cmd = ["pgrep", "-f", this.pgrepPattern];
    try {
      const { exitCode, stderr } = await this.spawn(cmd);
      if (exitCode === 0) {
        return { healthy: true, detail: `pgrep matched "${this.pgrepPattern}"` };
      }
      if (exitCode === 1) {
        return { healthy: false, detail: "omc wait not running (pgrep exit=1)" };
      }
      return {
        healthy: false,
        detail: `pgrep exit=${exitCode}: ${stderr.trim() || "(no stderr)"}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { healthy: false, detail: `pgrep spawn failed: ${msg}` };
    }
  }

  async restart(): Promise<RestartResult> {
    return this.serviceManager.restart(this.serviceLabel);
  }
}
