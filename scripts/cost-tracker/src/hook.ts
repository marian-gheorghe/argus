import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { Accumulator, type ThresholdLevel as MarkLevel } from "./accumulator.ts";
import { ClawhipEmitter, type CostEmitter, type CostEventName } from "./emit.ts";
import { Policy } from "./policy.ts";
import { Pricing, type Tier } from "./pricing.ts";
import { type ThresholdLevel, evaluate } from "./thresholds.ts";

/**
 * PostToolUse hook entrypoint.
 *
 * Contract: Claude Code feeds a JSON object on stdin (PostToolUse payload),
 * we read it, accumulate per-run cost, and emit clawhip events at the
 * configured thresholds.
 *
 * EXIT 0 ALWAYS. A hook crash MUST NEVER block the agent. Any internal
 * failure is logged to stderr (visible in Claude Code's debug logs) and the
 * process exits cleanly. Tests inject a `stderr` sink so we can assert on
 * the warning content.
 */

/** Subset of the PostToolUse payload we care about. Permissive on other fields. */
const HookInput = z
  .object({
    hook_event_name: z.string().optional(),
    tool_name: z.string().optional(),
    tool_response: z
      .object({
        model: z.string().optional(),
        usage: z
          .object({
            input_tokens: z.number().int().nonnegative().optional(),
            output_tokens: z.number().int().nonnegative().optional(),
            cache_creation_input_tokens: z.number().int().nonnegative().optional(),
            cache_read_input_tokens: z.number().int().nonnegative().optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

export interface HookDeps {
  stdin: string;
  env: Record<string, string | undefined>;
  policyPath: string;
  pricingPath: string;
  dbPath: string;
  emitter: CostEmitter;
  pauseRun: (run_id: string) => Promise<void>;
  cancelRun: (run_id: string) => Promise<void>;
  stderr: (msg: string) => void;
}

export function modelToTier(model: string): Tier | null {
  if (!model) return null;
  // Match against well-known prefixes. Order matters: we check sonnet AFTER
  // haiku because "haiku" appears before "sonnet" in the model name namespace
  // but that's irrelevant — substring-includes is unambiguous either way.
  if (/haiku/i.test(model)) return "haiku";
  if (/sonnet/i.test(model)) return "sonnet";
  if (/opus/i.test(model)) return "opus";
  return null;
}

const LEVEL_TO_EVENT: Record<Exclude<ThresholdLevel, "none">, CostEventName> = {
  warn: "cost.warn",
  page: "cost.page",
  kill: "cost.kill",
};

const LEVEL_ORDER: Exclude<ThresholdLevel, "none">[] = ["warn", "page", "kill"];

/**
 * Run the hook. Returns the exit code (always 0 in production; tests assert
 * on side effects + stderr output).
 *
 * Wraps the entire body in try/catch — a hook crash must never block the
 * agent. If anything throws, we log to stderr and return 0.
 */
export async function runHook(deps: HookDeps): Promise<number> {
  try {
    // 1. Load policy. If max20 mode, no-op.
    let policy: Policy;
    try {
      policy = Policy.load(deps.policyPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`cost-tracker: policy load failed: ${msg}\n`);
      return 0;
    }
    if (policy.billing === "max20") {
      // Silent no-op. The hook is registered globally but does nothing in
      // Max20 mode by design.
      return 0;
    }

    // 2. Resolve run_id. Without it we can't accumulate; warn + exit 0.
    const run_id = deps.env.OMC_CURRENT_RUN_ID;
    if (!run_id) {
      deps.stderr("cost-tracker: OMC_CURRENT_RUN_ID is not set; skipping accumulation\n");
      return 0;
    }

    // 3. Parse stdin.
    let parsed: unknown;
    try {
      parsed = JSON.parse(deps.stdin);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`cost-tracker: stdin JSON parse failed: ${msg}\n`);
      return 0;
    }
    const validated = HookInput.safeParse(parsed);
    if (!validated.success) {
      deps.stderr(`cost-tracker: stdin shape invalid: ${validated.error.message}\n`);
      return 0;
    }

    const usage = validated.data.tool_response?.usage;
    if (!usage) {
      // No usage block (e.g., a tool call that didn't go through the model).
      // Silently no-op.
      return 0;
    }

    // 4. Resolve tier from model name.
    const modelName = validated.data.tool_response?.model ?? "";
    let tier = modelToTier(modelName);
    if (!tier) {
      deps.stderr(
        `cost-tracker: unknown model "${modelName}", defaulting to sonnet (safe middle-of-road)\n`,
      );
      tier = "sonnet";
    }

    // 5. Load pricing.
    let pricing: Pricing;
    try {
      pricing = Pricing.load(deps.pricingPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`cost-tracker: pricing load failed: ${msg}\n`);
      return 0;
    }

    // 6. Open accumulator. Ensure parent dir exists (first-ever invocation).
    let acc: Accumulator;
    try {
      mkdirSync(dirname(deps.dbPath), { recursive: true });
      acc = new Accumulator(deps.dbPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`cost-tracker: accumulator open failed: ${msg}\n`);
      return 0;
    }

    try {
      acc.ensureRun(run_id, policy.apiCeilingEur);

      const phase = `tool=${validated.data.tool_name ?? "unknown"}`;
      const inputTokens = usage.input_tokens ?? 0;
      const cachedTokens = usage.cache_read_input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      acc.add(run_id, tier, "input", inputTokens, phase, pricing);
      acc.add(run_id, tier, "cached_input", cachedTokens, phase, pricing);
      acc.add(run_id, tier, "output", outputTokens, phase, pricing);

      // 7. Evaluate thresholds and emit any newly-crossed levels (in order).
      const row = acc.getRun(run_id);
      if (!row) return 0; // shouldn't happen — ensureRun ran above
      const reached = evaluate(row.spent_eur, row.ceiling_eur, policy.thresholds);
      if (reached === "none") return 0;

      // We emit ALL crossed-but-not-yet-emitted levels up to and including
      // `reached`. This handles the common case where a single big add
      // jumps from 0% straight past 75% and 100% — both should fire.
      for (const level of LEVEL_ORDER) {
        if (rank(level) > rank(reached)) break;
        await tryEmitOne(level, acc, run_id, row.spent_eur, row.ceiling_eur, deps);
      }
    } finally {
      acc.close();
    }

    return 0;
  } catch (e) {
    // Last-resort safety net: any unexpected throw.
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`cost-tracker: unexpected error: ${msg}\n`);
    return 0;
  }
}

function rank(level: Exclude<ThresholdLevel, "none">): number {
  return level === "warn" ? 1 : level === "page" ? 2 : 3;
}

async function tryEmitOne(
  level: Exclude<ThresholdLevel, "none">,
  acc: Accumulator,
  run_id: string,
  spent: number,
  ceiling: number,
  deps: HookDeps,
): Promise<void> {
  const fresh = acc.markEmitted(run_id, level as MarkLevel);
  if (!fresh) return; // already emitted on a prior hook fire

  const event = LEVEL_TO_EVENT[level];
  const payload = {
    run_id,
    spent_eur: roundEur(spent),
    ceiling_eur: ceiling,
    ratio: ceiling > 0 ? spent / ceiling : null,
    level,
    timestamp: new Date().toISOString(),
  };

  // 8. Emit. Failure is logged but never propagated.
  try {
    await deps.emitter.emit(event, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`cost-tracker: emit ${event} failed: ${msg}\n`);
  }

  // 9. For page/kill, also try to pause/cancel via OMC. Best-effort; failure
  // logs but does not break the hook.
  if (level === "page") {
    try {
      await deps.pauseRun(run_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`cost-tracker: omc pause ${run_id} failed: ${msg}\n`);
    }
  } else if (level === "kill") {
    try {
      await deps.cancelRun(run_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`cost-tracker: omc cancel ${run_id} failed: ${msg}\n`);
    }
  }
}

function roundEur(n: number): number {
  // 6 decimal places — submillicent precision, plenty for accumulator output.
  return Math.round(n * 1_000_000) / 1_000_000;
}

// CLI entry: read stdin, build prod deps, run.
if (import.meta.main) {
  void main();
}

async function main(): Promise<void> {
  const stdin = await new Response(Bun.stdin.stream()).text();
  const home = process.env.HOME ?? "";
  const policyPath = process.env.ARGUS_POLICY_PATH ?? `${home}/.claude/omc/argus/policy.toml`;
  const pricingPath = process.env.ARGUS_PRICING_PATH ?? `${home}/.argus/pricing.toml`;
  const dbPath = process.env.ARGUS_COST_DB ?? `${home}/.argus/state/cost-tracker.sqlite`;

  const emitter = new ClawhipEmitter();
  const pauseRun = async (run_id: string): Promise<void> => {
    await spawnBestEffort(["omc", "pause", run_id]);
  };
  const cancelRun = async (run_id: string): Promise<void> => {
    await spawnBestEffort(["omc", "cancel", run_id]);
  };

  const code = await runHook({
    stdin,
    env: process.env,
    policyPath,
    pricingPath,
    dbPath,
    emitter,
    pauseRun,
    cancelRun,
    stderr: (msg) => process.stderr.write(msg),
  });
  process.exit(code);
}

async function spawnBestEffort(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderrText = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} exited ${proc.exitCode}: ${stderrText.trim() || "(no stderr)"}`,
    );
  }
}
