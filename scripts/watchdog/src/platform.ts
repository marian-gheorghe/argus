import type { RestartResult } from "./check.ts";

/**
 * Platform abstraction. macOS = launchd; Linux = systemd. The watchdog asks
 * a `ServiceManager` to bounce a labelled service; the manager translates
 * that into the right CLI invocation.
 *
 * Why an abstraction instead of inlining `if (platform === "darwin")` at each
 * check site: the same Check class (`ClawhipCheck`, `BridgeCheck`) ships on
 * both Mac and Linux. The check shouldn't care which init system is wired up;
 * it just hands the service-manager a label and trusts it.
 *
 * Service labels CAN differ between platforms (`com.argus.clawhip` vs
 * `argus-clawhip.service`) — the check classes pass platform-correct labels
 * via constructor injection from `index.ts`.
 */
export type Platform = "darwin" | "linux";

export type SpawnFn = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;

export interface ServiceManager {
  restart(label: string): Promise<RestartResult>;
}

export function detectPlatform(): Platform {
  const p = process.platform;
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  // Fallback: treat unknown UNIX as linux. The watchdog is not designed to
  // run on Windows; this avoids `Platform | undefined` everywhere downstream.
  return "linux";
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

/**
 * macOS launchd manager. `launchctl kickstart -k gui/<uid>/<label>` will
 * stop a running service and immediately start it again — equivalent of a
 * "bounce". On a service that's stopped, kickstart starts it. Either way,
 * the post-condition is "service is running".
 *
 * gui/<uid> is the user's GUI domain — where launchd plists from
 * ~/Library/LaunchAgents are loaded. We resolve uid at construction
 * (or take an explicit value for testability).
 */
export class LaunchdManager implements ServiceManager {
  private readonly spawn: SpawnFn;
  private readonly uid: number;

  constructor(opts?: { spawn?: SpawnFn; uid?: number }) {
    this.spawn = opts?.spawn ?? defaultSpawn;
    this.uid = opts?.uid ?? process.getuid?.() ?? 0;
  }

  async restart(label: string): Promise<RestartResult> {
    const cmd = ["launchctl", "kickstart", "-k", `gui/${this.uid}/${label}`];
    try {
      const { exitCode, stderr } = await this.spawn(cmd);
      if (exitCode !== 0) {
        return {
          ok: false,
          detail: `launchctl exit=${exitCode}: ${stderr.trim() || "(no stderr)"}`,
        };
      }
      return { ok: true, detail: `kickstarted ${label}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, detail: `spawn failed: ${msg}` };
    }
  }
}

/**
 * Linux systemd user-service manager. `systemctl --user restart <label>` will
 * stop and start the unit. Requires the `argus` user's systemd-user instance
 * to be running (`loginctl enable-linger argus` if you want it without an
 * active login session — that's a Block 4 concern).
 */
export class SystemdManager implements ServiceManager {
  private readonly spawn: SpawnFn;

  constructor(opts?: { spawn?: SpawnFn }) {
    this.spawn = opts?.spawn ?? defaultSpawn;
  }

  async restart(label: string): Promise<RestartResult> {
    const cmd = ["systemctl", "--user", "restart", label];
    try {
      const { exitCode, stderr } = await this.spawn(cmd);
      if (exitCode !== 0) {
        return {
          ok: false,
          detail: `systemctl exit=${exitCode}: ${stderr.trim() || "(no stderr)"}`,
        };
      }
      return { ok: true, detail: `restarted ${label}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, detail: `spawn failed: ${msg}` };
    }
  }
}

export function makeServiceManager(platform: Platform): ServiceManager {
  return platform === "darwin" ? new LaunchdManager() : new SystemdManager();
}
