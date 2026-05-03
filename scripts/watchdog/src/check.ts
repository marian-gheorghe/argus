/**
 * Check interface — every health check the watchdog runs implements this.
 *
 * Design notes:
 * - `check()` is the cheap liveness probe. It MUST return within the
 *   implementation's own timeout budget (typically 5s) — the runner does NOT
 *   impose its own timeout. Implementations that wrap fetch / spawn must
 *   carry an AbortSignal. A check that hangs forever effectively starves
 *   the watchdog tick — implementations are responsible for not doing that.
 * - `restart()` is the recovery action. It is only called when the runner
 *   has decided the check is consistently unhealthy (≥ threshold consecutive
 *   failures). The Escalator throttles repeated restart attempts via a
 *   cooldown, so implementations don't need internal backoff.
 * - Both methods MUST NOT throw. Failures are reported via the result
 *   shape (`healthy: false` or `ok: false`). The runner catches stray
 *   throws as a defensive belt-and-braces — but that path is for bugs,
 *   not normal control flow.
 *
 * `name` is the stable identifier used in logs and as the key in the runner's
 * per-check failure counter map. Must be unique across the registered checks.
 */

export interface CheckResult {
  healthy: boolean;
  detail: string;
}

export interface RestartResult {
  ok: boolean;
  detail: string;
}

export interface Check {
  readonly name: string;
  check(): Promise<CheckResult>;
  restart(): Promise<RestartResult>;
}
