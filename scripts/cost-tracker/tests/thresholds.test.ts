import { describe, expect, test } from "bun:test";
import { evaluate } from "../src/thresholds.ts";

const RATIOS = { warn: 0.75, page: 1.0, kill: 1.1 };

describe("thresholds.evaluate", () => {
  test("under all thresholds returns 'none'", () => {
    expect(evaluate(0.0, 50, RATIOS)).toBe("none");
    expect(evaluate(37.4, 50, RATIOS)).toBe("none"); // 74.8%
    // exactly at warn boundary minus an epsilon → still none
    expect(evaluate(50 * 0.75 - 0.001, 50, RATIOS)).toBe("none");
  });

  test("at exactly warn ratio returns 'warn' (>= comparison)", () => {
    expect(evaluate(50 * 0.75, 50, RATIOS)).toBe("warn");
  });

  test("between warn and page returns 'warn'", () => {
    expect(evaluate(40, 50, RATIOS)).toBe("warn"); // 80%
    expect(evaluate(49.5, 50, RATIOS)).toBe("warn"); // 99%
  });

  test("at exactly page ratio returns 'page'", () => {
    expect(evaluate(50.0, 50, RATIOS)).toBe("page");
  });

  test("between page and kill returns 'page'", () => {
    expect(evaluate(53.0, 50, RATIOS)).toBe("page"); // 106%
  });

  test("at exactly kill ratio returns 'kill'", () => {
    expect(evaluate(55.0, 50, RATIOS)).toBe("kill"); // 110%
  });

  test("over kill ratio returns 'kill'", () => {
    expect(evaluate(75.0, 50, RATIOS)).toBe("kill"); // 150%
  });

  test("custom ratios are honoured", () => {
    const tight = { warn: 0.5, page: 0.8, kill: 0.95 };
    expect(evaluate(20, 50, tight)).toBe("none"); // 40%
    expect(evaluate(25, 50, tight)).toBe("warn"); // 50%
    expect(evaluate(40, 50, tight)).toBe("page"); // 80%
    expect(evaluate(50, 50, tight)).toBe("kill"); // 100% > 95%
  });

  test("zero ceiling is treated as 'kill' on any positive spend (defensive)", () => {
    // A misconfigured 0-EUR ceiling should still produce a deterministic kill
    // signal rather than dividing by zero.
    expect(evaluate(0, 0, RATIOS)).toBe("none");
    expect(evaluate(0.01, 0, RATIOS)).toBe("kill");
  });

  test("negative spend returns 'none' (clamp defensively)", () => {
    expect(evaluate(-1, 50, RATIOS)).toBe("none");
  });
});
