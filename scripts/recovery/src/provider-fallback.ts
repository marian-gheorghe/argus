import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecoveryEmitter } from "./emit.ts";
import { ManifestStore } from "./manifest.ts";

/**
 * Provider-outage fallback. Mode (f) of design §8 (Anthropic API
 * outage / Max20 outage). Toggles between API and Max20 credentials.
 *
 * Invoked by clawhip's `provider.outage` event handler. Logic:
 * 1. Read $argusDir/secrets.env to determine which credentials exist.
 * 2. Toggle: if currently API and Max20 creds present → switch to
 *    Max20. If currently Max20 and API creds present → switch to API.
 *    Otherwise emit `provider.fallback-unavailable` PAGE.
 * 3. Persist the choice to the manifest AND to a small env-override
 *    file the OMC wrapper sources at boot
 *    (`$stateDir/provider-override.env`).
 * 4. Stamp `provider_outage_started_at` if not already set.
 * 5. Emit `provider.fallback-engaged` WARN with the new mode.
 * 6. Anti-flap: if the manifest was switched within FLAP_WINDOW_MS,
 *    skip the toggle to avoid oscillation.
 * 7. After pageAfterMs of continuous outage (default 2h), emit
 *    `provider.outage-prolonged` PAGE in addition to the regular
 *    fallback-engaged signal.
 */

export interface ProviderFallbackDeps {
  env: Record<string, string | undefined>;
  stateDir: string;
  argusDir: string;
  emitter: RecoveryEmitter;
  stderr: (msg: string) => void;
  now: () => Date;
  pageAfterMs: number;
}

const FLAP_WINDOW_MS = 60_000;

export async function runProviderFallback(deps: ProviderFallbackDeps): Promise<number> {
  try {
    const run_id = deps.env.OMC_CURRENT_RUN_ID;
    if (!run_id) return 0;

    const store = new ManifestStore(deps.stateDir);
    const current = store.read(run_id);
    if (!current) return 0;

    const creds = readCredsAvailability(deps.argusDir);
    const nowMs = deps.now().getTime();

    // Always evaluate the prolonged-outage page first — it doesn't depend
    // on whether we toggled successfully.
    const outageStart = current.provider_outage_started_at
      ? new Date(current.provider_outage_started_at).getTime()
      : null;
    if (outageStart !== null && nowMs - outageStart >= deps.pageAfterMs) {
      try {
        await deps.emitter.emit("provider.outage-prolonged", "page", {
          run_id,
          outage_started_at: current.provider_outage_started_at,
          duration_ms: nowMs - outageStart,
          current_mode: current.provider_mode,
          timestamp: deps.now().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.stderr(`provider-fallback: emit failed: ${msg}\n`);
      }
    }

    // Anti-flap: if we already switched modes within FLAP_WINDOW_MS, don't
    // toggle again. Without this, a steady stream of provider.outage events
    // would oscillate the mode every event. Track via a side-channel field
    // on the manifest (passthrough preserves it across reads).
    const lastSwitch = (current as unknown as { provider_mode_switched_at?: string })
      .provider_mode_switched_at;
    if (lastSwitch) {
      const ageMs = nowMs - new Date(lastSwitch).getTime();
      if (ageMs < FLAP_WINDOW_MS) {
        return 0;
      }
    }

    // Determine target mode based on current + creds availability.
    const currentMode = current.provider_mode;
    let targetMode: "max20" | "api" | null = null;
    if (currentMode === "api" && creds.max20) targetMode = "max20";
    else if (currentMode === "max20" && creds.api) targetMode = "api";

    if (targetMode === null) {
      // No fallback path available. Page so a human can intervene.
      try {
        await deps.emitter.emit("provider.fallback-unavailable", "page", {
          run_id,
          current_mode: currentMode,
          have_max20: creds.max20,
          have_api: creds.api,
          timestamp: deps.now().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.stderr(`provider-fallback: emit failed: ${msg}\n`);
      }
      return 0;
    }

    // Persist override file BEFORE updating the manifest so OMC's wrapper
    // sees the new env on next boot regardless of subsequent failures.
    writeOverrideFile(deps.stateDir, targetMode);

    store.update(run_id, (m) => ({
      ...m,
      provider_mode: targetMode,
      provider_outage_started_at: m.provider_outage_started_at ?? deps.now().toISOString(),
      // passthrough field: tracked to suppress oscillation between providers
      provider_mode_switched_at: deps.now().toISOString(),
    }));

    try {
      await deps.emitter.emit("provider.fallback-engaged", "warn", {
        run_id,
        previous_mode: currentMode,
        new_mode: targetMode,
        outage_started_at: current.provider_outage_started_at ?? deps.now().toISOString(),
        timestamp: deps.now().toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`provider-fallback: emit failed: ${msg}\n`);
    }

    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`provider-fallback: unexpected error: ${msg}\n`);
    return 0;
  }
}

interface CredsAvailability {
  max20: boolean;
  api: boolean;
}

function readCredsAvailability(argusDir: string): CredsAvailability {
  const path = join(argusDir, "secrets.env");
  if (!existsSync(path)) return { max20: false, api: false };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { max20: false, api: false };
  }
  // Look for key signals; tolerant of `KEY="..."` or `KEY=...` forms. We
  // avoid sourcing the file (would need a subshell); regexes are enough.
  const max20 = /CLAUDE_CODE_OAUTH_TOKEN\s*=\s*["']?[A-Za-z0-9_-]+["']?/.test(raw);
  const api = /ANTHROPIC_API_KEY\s*=\s*["']?[A-Za-z0-9_-]+["']?/.test(raw);
  return { max20, api };
}

function writeOverrideFile(stateDir: string, mode: "max20" | "api"): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "provider-override.env");
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(
    tmp,
    `# Argus auto-rendered — provider-fallback override\nARGUS_PROVIDER=${mode}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  // rename(2) is atomic on the same fs.
  require("node:fs").renameSync(tmp, path);
}
