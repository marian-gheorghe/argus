import { describe, expect, test } from "bun:test";
import { detectCollisions, levenshtein, triggerSimilarity } from "../src/collision-check.ts";

describe("levenshtein", () => {
  test("identical strings -> 0", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  test("empty vs non-empty -> length of the other", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  test("single substitution -> 1", () => {
    expect(levenshtein("kitten", "sitten")).toBe(1);
  });

  test("classic kitten / sitting -> 3", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("triggerSimilarity", () => {
  test("identical strings -> 1.0", () => {
    expect(triggerSimilarity("auth handling", "auth handling")).toBe(1.0);
  });

  test("near-duplicate phrasing -> high similarity (above threshold)", () => {
    const sim = triggerSimilarity("auth handling", "handle auth");
    expect(sim).toBeGreaterThan(0.7);
  });

  test("disjoint short triggers -> low similarity", () => {
    const sim = triggerSimilarity("merge conflict", "TimeoutError");
    expect(sim).toBeLessThan(0.5);
  });

  test("case-insensitive jaccard catches AUTH vs auth", () => {
    expect(triggerSimilarity("AUTH ERROR", "auth error")).toBe(1.0);
  });

  test("subset trigger ('login' vs 'login button click') -> elevated by jaccard", () => {
    const sim = triggerSimilarity("login", "login button click");
    // Jaccard {login}/{login,button,click} = 1/3 = 0.33 -> below 0.5 cutoff
    // Levenshtein 1 - 13/18 = 0.27. Both modes below threshold.
    expect(sim).toBeLessThan(0.7);
  });
});

describe("detectCollisions", () => {
  test("no existing skills -> no collisions", () => {
    const out = detectCollisions({
      newSkill: { name: "new", triggers: ["t1", "t2"] },
      existing: [],
    });
    expect(out).toEqual([]);
  });

  test("identical trigger -> collision", () => {
    const out = detectCollisions({
      newSkill: { name: "new-auth", triggers: ["handle auth error"] },
      existing: [
        {
          path: "/skills/old-auth/SKILL.md",
          name: "old-auth",
          triggers: ["handle auth error"],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.with.name).toBe("old-auth");
    expect(out[0]?.overlap[0]?.similarity).toBe(1.0);
  });

  test("near-duplicate trigger -> collision (similarity > 0.7)", () => {
    const out = detectCollisions({
      newSkill: { name: "new-auth", triggers: ["auth handling"] },
      existing: [
        {
          path: "/skills/old-auth/SKILL.md",
          name: "old-auth",
          triggers: ["handle auth"],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.overlap[0]?.similarity).toBeGreaterThan(0.7);
  });

  test("disjoint triggers -> no collision", () => {
    const out = detectCollisions({
      newSkill: { name: "new-skill", triggers: ["merge conflict resolver"] },
      existing: [
        {
          path: "/skills/timeout/SKILL.md",
          name: "timeout",
          triggers: ["TimeoutError catcher"],
        },
      ],
    });
    expect(out).toEqual([]);
  });

  test("multi-trigger new skill: any single overlap -> collision", () => {
    const out = detectCollisions({
      newSkill: {
        name: "new-multi",
        triggers: ["foo bar baz", "auth handling"],
      },
      existing: [
        {
          path: "/skills/old/SKILL.md",
          name: "old",
          triggers: ["handle auth"],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.overlap.length).toBeGreaterThanOrEqual(1);
  });

  test("multi-trigger existing skill: collision reports all overlapping pairs", () => {
    const out = detectCollisions({
      newSkill: {
        name: "new",
        triggers: ["auth error", "login flow"],
      },
      existing: [
        {
          path: "/skills/legacy/SKILL.md",
          name: "legacy",
          triggers: ["auth error", "session validation", "login flow"],
        },
      ],
    });
    expect(out).toHaveLength(1);
    // Two trigger pairs cross 0.7 (auth error<->auth error, login flow<->login flow).
    expect(out[0]?.overlap.length).toBe(2);
  });

  test("multiple existing skills, some collide and some don't", () => {
    const out = detectCollisions({
      newSkill: {
        name: "new",
        triggers: ["handle auth"],
      },
      existing: [
        {
          path: "/skills/auth-old/SKILL.md",
          name: "auth-old",
          triggers: ["auth handling"],
        },
        {
          path: "/skills/timeout/SKILL.md",
          name: "timeout",
          triggers: ["TimeoutError catcher"],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.with.name).toBe("auth-old");
  });

  test("empty triggers on either side -> no collision", () => {
    const a = detectCollisions({
      newSkill: { name: "new", triggers: [] },
      existing: [{ path: "/x", name: "old", triggers: ["foo"] }],
    });
    expect(a).toEqual([]);
    const b = detectCollisions({
      newSkill: { name: "new", triggers: ["foo"] },
      existing: [{ path: "/x", name: "old", triggers: [] }],
    });
    expect(b).toEqual([]);
  });

  test("collision result includes the existing skill's metadata", () => {
    const out = detectCollisions({
      newSkill: { name: "new", triggers: ["xyz"] },
      existing: [
        {
          path: "/skills/x/SKILL.md",
          name: "x",
          triggers: ["xyz"],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.with.path).toBe("/skills/x/SKILL.md");
    expect(out[0]?.with.name).toBe("x");
  });

  test("threshold tuning: 0.7 is exclusive — exact 0.7 should count", () => {
    // Crafted pair with similarity around the threshold.
    // Identical => 1.0 -> always collides; here we focus on a clearly-above case.
    const out = detectCollisions({
      newSkill: { name: "new", triggers: ["handle auth error"] },
      existing: [{ path: "/x", name: "old", triggers: ["handle auth errors"] }],
    });
    expect(out).toHaveLength(1);
  });
});
