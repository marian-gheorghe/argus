import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pricing } from "../src/pricing.ts";

let tmpDir: string;
let pricingPath: string;

const fixture = `
[claude-haiku]
input_eur_per_million = 0.80
cached_input_eur_per_million = 0.10
output_eur_per_million = 4.00

[claude-sonnet]
input_eur_per_million = 3.00
cached_input_eur_per_million = 0.30
output_eur_per_million = 15.00

[claude-opus]
input_eur_per_million = 15.00
cached_input_eur_per_million = 1.50
output_eur_per_million = 75.00
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-pricing-"));
  pricingPath = join(tmpDir, "pricing.toml");
  writeFileSync(pricingPath, fixture);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Pricing.load", () => {
  test("loads a real TOML file and parses tier rates", () => {
    const p = Pricing.load(pricingPath);
    // 3.00 EUR per 1M tokens → 3.00e-6 EUR per token
    expect(p.rate("sonnet", "input")).toBeCloseTo(3.0e-6, 12);
    expect(p.rate("sonnet", "cached_input")).toBeCloseTo(0.3e-6, 12);
    expect(p.rate("sonnet", "output")).toBeCloseTo(15.0e-6, 12);
    expect(p.rate("haiku", "input")).toBeCloseTo(0.8e-6, 12);
    expect(p.rate("opus", "output")).toBeCloseTo(75.0e-6, 12);
  });

  test("throws a clear error when the file does not exist", () => {
    expect(() => Pricing.load(join(tmpDir, "nope.toml"))).toThrow(/not found|ENOENT|no such/i);
  });

  test("throws a clear error when a tier section is missing", () => {
    writeFileSync(
      pricingPath,
      `
[claude-haiku]
input_eur_per_million = 0.80
cached_input_eur_per_million = 0.10
output_eur_per_million = 4.00
`,
    );
    const p = Pricing.load(pricingPath);
    expect(() => p.rate("sonnet", "input")).toThrow(/sonnet/i);
  });

  test("throws when a tier section is missing a required token-type field", () => {
    writeFileSync(
      pricingPath,
      `
[claude-haiku]
input_eur_per_million = 0.80
# cached_input_eur_per_million omitted on purpose
output_eur_per_million = 4.00
`,
    );
    expect(() => Pricing.load(pricingPath)).toThrow(/cached_input|haiku/i);
  });
});

describe("Pricing.fromObject", () => {
  test("constructs a table from a plain object (test helper)", () => {
    const p = Pricing.fromObject({
      haiku: { input: 0.8e-6, cached_input: 0.1e-6, output: 4.0e-6 },
      sonnet: { input: 3.0e-6, cached_input: 0.3e-6, output: 15.0e-6 },
      opus: { input: 15.0e-6, cached_input: 1.5e-6, output: 75.0e-6 },
    });
    expect(p.rate("haiku", "input")).toBeCloseTo(0.8e-6, 12);
    expect(p.rate("opus", "cached_input")).toBeCloseTo(1.5e-6, 12);
  });
});

describe("Pricing.costFor", () => {
  test("multiplies tokens by per-token rates and sums correctly", () => {
    const p = Pricing.fromObject({
      haiku: { input: 0.8e-6, cached_input: 0.1e-6, output: 4.0e-6 },
      sonnet: { input: 3.0e-6, cached_input: 0.3e-6, output: 15.0e-6 },
      opus: { input: 15.0e-6, cached_input: 1.5e-6, output: 75.0e-6 },
    });
    // 1M input @ 3 EUR + 0 cached + 1M output @ 15 EUR = 18 EUR
    const cost = p.costFor("sonnet", 1_000_000, 0, 1_000_000);
    expect(cost).toBeCloseTo(18.0, 6);
  });

  test("handles fractional sums to 6 decimal precision", () => {
    const p = Pricing.fromObject({
      haiku: { input: 0.8e-6, cached_input: 0.1e-6, output: 4.0e-6 },
      sonnet: { input: 3.0e-6, cached_input: 0.3e-6, output: 15.0e-6 },
      opus: { input: 15.0e-6, cached_input: 1.5e-6, output: 75.0e-6 },
    });
    // 1234 input + 5678 cached + 999 output on opus
    // = 1234*15e-6 + 5678*1.5e-6 + 999*75e-6
    // = 0.01851 + 0.008517 + 0.074925 = 0.101952
    const cost = p.costFor("opus", 1234, 5678, 999);
    expect(cost).toBeCloseTo(0.101952, 6);
  });

  test("returns 0 for zero tokens", () => {
    const p = Pricing.fromObject({
      haiku: { input: 0.8e-6, cached_input: 0.1e-6, output: 4.0e-6 },
      sonnet: { input: 3.0e-6, cached_input: 0.3e-6, output: 15.0e-6 },
      opus: { input: 15.0e-6, cached_input: 1.5e-6, output: 75.0e-6 },
    });
    expect(p.costFor("opus", 0, 0, 0)).toBe(0);
  });
});
