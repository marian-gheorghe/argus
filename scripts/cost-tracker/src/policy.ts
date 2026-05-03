import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseToml } from "./toml.ts";

export type BillingMode = "max20" | "api";

export interface ThresholdRatios {
  warn: number;
  page: number;
  kill: number;
}

export type TierRouting = Record<string, string>;

const BillingSchema = z.enum(["max20", "api"]);

const DefaultSection = z
  .object({
    billing: BillingSchema,
    api_ceiling_eur: z.number().positive(),
    api_ceiling_overridable: z.boolean().default(true),
  })
  .strict();

const ThresholdSection = z
  .object({
    warn: z.number().positive(),
    page: z.number().positive(),
    kill: z.number().positive(),
  })
  .strict();

const DEFAULT_THRESHOLDS: ThresholdRatios = { warn: 0.75, page: 1.0, kill: 1.1 };

export class Policy {
  readonly billing: BillingMode;
  readonly apiCeilingEur: number;
  readonly apiCeilingOverridable: boolean;
  readonly thresholds: ThresholdRatios;
  readonly tierRouting: TierRouting;

  private constructor(args: {
    billing: BillingMode;
    apiCeilingEur: number;
    apiCeilingOverridable: boolean;
    thresholds: ThresholdRatios;
    tierRouting: TierRouting;
  }) {
    this.billing = args.billing;
    this.apiCeilingEur = args.apiCeilingEur;
    this.apiCeilingOverridable = args.apiCeilingOverridable;
    this.thresholds = args.thresholds;
    this.tierRouting = args.tierRouting;
  }

  static load(path: string): Policy {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Policy.load: cannot read ${path}: ${msg}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Policy.load: invalid TOML in ${path}: ${msg}`);
    }

    const defaultRaw = parsed.default;
    if (defaultRaw === undefined) {
      throw new Error(`Policy.load: missing [default] section in ${path}`);
    }
    const defaultParsed = DefaultSection.safeParse(defaultRaw);
    if (!defaultParsed.success) {
      throw new Error(`Policy.load: invalid [default] section: ${defaultParsed.error.message}`);
    }

    let thresholds = DEFAULT_THRESHOLDS;
    const tRaw = parsed.tier_thresholds;
    if (tRaw !== undefined) {
      const tParsed = ThresholdSection.safeParse(tRaw);
      if (!tParsed.success) {
        throw new Error(`Policy.load: invalid [tier_thresholds] section: ${tParsed.error.message}`);
      }
      thresholds = { warn: tParsed.data.warn, page: tParsed.data.page, kill: tParsed.data.kill };
    }

    const tierRouting: TierRouting = {};
    const trRaw = parsed.tier_routing;
    if (trRaw !== undefined) {
      if (typeof trRaw !== "object" || trRaw === null) {
        throw new Error("Policy.load: [tier_routing] must be a table");
      }
      for (const [k, v] of Object.entries(trRaw as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new Error(`Policy.load: tier_routing.${k} must be a string, got ${typeof v}`);
        }
        tierRouting[k] = v;
      }
    }

    return new Policy({
      billing: defaultParsed.data.billing,
      apiCeilingEur: defaultParsed.data.api_ceiling_eur,
      apiCeilingOverridable: defaultParsed.data.api_ceiling_overridable,
      thresholds,
      tierRouting,
    });
  }
}
