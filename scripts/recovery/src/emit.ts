/**
 * Recovery-event emitter abstraction.
 *
 * Mirrors `scripts/cost-tracker/src/emit.ts`. All recovery events
 * carry a deterministic `event_id = "<event>:<run_id>"` so clawhip's
 * outbound queue can dedup re-emissions.
 */

export type RecoverySeverity = "info" | "warn" | "page" | "critical";

export interface RecoveryEmitter {
  emit(event: string, severity: RecoverySeverity, payload: Record<string, unknown>): Promise<void>;
}

/** Test helper. Records every emit call; can be programmed to throw once. */
export class MockEmitter implements RecoveryEmitter {
  readonly calls: {
    event: string;
    severity: RecoverySeverity;
    payload: Record<string, unknown>;
  }[] = [];
  private failNextError: string | null = null;

  failNext(error: string): void {
    this.failNextError = error;
  }

  emit(event: string, severity: RecoverySeverity, payload: Record<string, unknown>): Promise<void> {
    if (this.failNextError !== null) {
      const err = this.failNextError;
      this.failNextError = null;
      return Promise.reject(new Error(err));
    }
    this.calls.push({ event, severity, payload });
    return Promise.resolve();
  }
}

/** Subset of `Bun.spawn` we use; reified as an injection point for tests. */
export type SpawnFn = (
  cmd: string[],
  stdin: string,
) => Promise<{ exitCode: number; stderr: string }>;

/**
 * Production emitter. Shells out to `clawhip send` via Bun.spawn (or an
 * injected spawner for tests). Sends payload as JSON on stdin via
 * `--stdin-json` so we don't shell-quote arbitrary message bodies.
 */
export class ClawhipEmitter implements RecoveryEmitter {
  private readonly spawn: SpawnFn;
  private readonly clawhipBin: string;

  constructor(opts?: { spawn?: SpawnFn; clawhipBin?: string }) {
    this.spawn = opts?.spawn ?? defaultSpawn;
    this.clawhipBin = opts?.clawhipBin ?? "clawhip";
  }

  async emit(
    event: string,
    severity: RecoverySeverity,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const run_id = typeof payload.run_id === "string" ? payload.run_id : "unknown-run";
    const event_id = `${event}:${run_id}`;
    const enriched = { event_id, ...payload };
    const stdin = JSON.stringify(enriched);
    const cmd = [this.clawhipBin, "send", "--event", event, "--severity", severity, "--stdin-json"];
    const { exitCode, stderr } = await this.spawn(cmd, stdin);
    if (exitCode !== 0) {
      throw new Error(`clawhip send exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`);
    }
  }
}

const defaultSpawn: SpawnFn = async (cmd, stdin) => {
  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [stderrText] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode: proc.exitCode ?? -1, stderr: stderrText };
};
