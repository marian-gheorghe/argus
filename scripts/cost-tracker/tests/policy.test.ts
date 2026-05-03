import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Policy } from "../src/policy.ts";

let tmpDir: string;
let policyPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-policy-"));
  policyPath = join(tmpDir, "policy.toml");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Policy.load", () => {
  test("loads max20 default with full section", () => {
    writeFileSync(
      policyPath,
      `
[default]
billing = "max20"
api_ceiling_eur = 50
api_ceiling_overridable = true

[tier_thresholds]
warn = 0.75
page = 1.00
kill = 1.10

[tier_routing]
exploration = "haiku"
routine = "sonnet"
architecture = "opus"
critic = "opus"
verify = "sonnet"
learner = "haiku"
`,
    );
    const p = Policy.load(policyPath);
    expect(p.billing).toBe("max20");
    expect(p.apiCeilingEur).toBe(50);
    expect(p.apiCeilingOverridable).toBe(true);
    expect(p.thresholds).toEqual({ warn: 0.75, page: 1.0, kill: 1.1 });
    expect(p.tierRouting).toEqual({
      exploration: "haiku",
      routine: "sonnet",
      architecture: "opus",
      critic: "opus",
      verify: "sonnet",
      learner: "haiku",
    });
  });

  test("loads api billing mode with custom ceiling", () => {
    writeFileSync(
      policyPath,
      `
[default]
billing = "api"
api_ceiling_eur = 0.50
api_ceiling_overridable = false

[tier_thresholds]
warn = 0.75
page = 1.00
kill = 1.10

[tier_routing]
exploration = "haiku"
routine = "sonnet"
architecture = "opus"
critic = "opus"
verify = "sonnet"
learner = "haiku"
`,
    );
    const p = Policy.load(policyPath);
    expect(p.billing).toBe("api");
    expect(p.apiCeilingEur).toBe(0.5);
    expect(p.apiCeilingOverridable).toBe(false);
  });

  test("rejects unknown billing mode", () => {
    writeFileSync(
      policyPath,
      `
[default]
billing = "unknown"
api_ceiling_eur = 50
api_ceiling_overridable = true

[tier_thresholds]
warn = 0.75
page = 1.00
kill = 1.10

[tier_routing]
exploration = "haiku"
routine = "sonnet"
architecture = "opus"
critic = "opus"
verify = "sonnet"
learner = "haiku"
`,
    );
    expect(() => Policy.load(policyPath)).toThrow(/billing/i);
  });

  test("throws when file is missing", () => {
    expect(() => Policy.load(join(tmpDir, "nope.toml"))).toThrow(/cannot read|ENOENT/i);
  });

  test("throws when [default] section is missing", () => {
    writeFileSync(policyPath, "[tier_thresholds]\nwarn = 0.75\npage = 1.0\nkill = 1.1\n");
    expect(() => Policy.load(policyPath)).toThrow(/default/i);
  });

  test("default fallback when tier_thresholds is missing uses 0.75 / 1.00 / 1.10", () => {
    writeFileSync(
      policyPath,
      `
[default]
billing = "api"
api_ceiling_eur = 50
api_ceiling_overridable = true
`,
    );
    const p = Policy.load(policyPath);
    expect(p.thresholds).toEqual({ warn: 0.75, page: 1.0, kill: 1.1 });
  });
});
