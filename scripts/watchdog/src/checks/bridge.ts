import type { Check, CheckResult, RestartResult } from "../check.ts";
import type { ServiceManager } from "../platform.ts";

/**
 * Telegram-bridge health check.
 *
 * Liveness signal: HTTP 200 from the local bridge `/health` endpoint
 * (default `http://127.0.0.1:9501/health`). The bridge serves this from
 * `src/server.ts`; it returns `{ok: true}` when the queue is reachable
 * and the dispatcher loop is running.
 *
 * Restart action: bounce `com.argus.telegram-bridge`.
 */

const DEFAULT_URL = "http://127.0.0.1:9501/health";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_LABEL = "com.argus.telegram-bridge";

/**
 * Narrow subset of `fetch` we depend on. Avoids TS complaining about Bun's
 * extra `preconnect` member when tests pass a hand-rolled mock.
 */
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface BridgeCheckDeps {
  serviceManager: ServiceManager;
  url?: string;
  fetchImpl?: FetchFn;
  timeoutMs?: number;
  serviceLabel?: string;
}

export class BridgeCheck implements Check {
  readonly name = "bridge";
  private readonly url: string;
  private readonly fetchImpl: FetchFn;
  private readonly timeoutMs: number;
  private readonly serviceLabel: string;
  private readonly serviceManager: ServiceManager;

  constructor(deps: BridgeCheckDeps) {
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
