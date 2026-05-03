import type { Check, CheckResult, RestartResult } from "../check.ts";
import type { ServiceManager } from "../platform.ts";

/**
 * Clawhip health check.
 *
 * Liveness signal: HTTP 200 from the local clawhip status endpoint
 * (default `http://127.0.0.1:25294/status`). Anything else — non-2xx,
 * timeout, network error — is unhealthy.
 *
 * Restart action: bounce the platform service labelled `com.argus.clawhip`
 * (launchd) or `argus-clawhip.service` (systemd). The label here is the
 * macOS launchd label; the install script renders the unit on Linux with
 * a different name. If you change either, also update the cross-platform
 * label resolution at the call site (or extend ClawhipCheckDeps to take
 * a serviceLabel).
 */

const DEFAULT_URL = "http://127.0.0.1:25294/status";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_LABEL = "com.argus.clawhip";

/**
 * Narrow subset of `fetch` we depend on. Avoids TS complaining about Bun's
 * extra `preconnect` member when tests pass a hand-rolled mock.
 */
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface ClawhipCheckDeps {
  serviceManager: ServiceManager;
  url?: string;
  fetchImpl?: FetchFn;
  timeoutMs?: number;
  serviceLabel?: string;
}

export class ClawhipCheck implements Check {
  readonly name = "clawhip";
  private readonly url: string;
  private readonly fetchImpl: FetchFn;
  private readonly timeoutMs: number;
  private readonly serviceLabel: string;
  private readonly serviceManager: ServiceManager;

  constructor(deps: ClawhipCheckDeps) {
    this.serviceManager = deps.serviceManager;
    this.url = deps.url ?? DEFAULT_URL;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.serviceLabel = deps.serviceLabel ?? DEFAULT_LABEL;
  }

  async check(): Promise<CheckResult> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, { signal: ctrl.signal });
      if (res.status === 200) {
        return { healthy: true, detail: `GET ${this.url} → 200` };
      }
      return { healthy: false, detail: `GET ${this.url} → ${res.status}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { healthy: false, detail: `GET ${this.url} threw: ${msg}` };
    } finally {
      clearTimeout(t);
    }
  }

  async restart(): Promise<RestartResult> {
    return this.serviceManager.restart(this.serviceLabel);
  }
}
