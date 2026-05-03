import { describe, expect, test } from "bun:test";
import { classifyScope } from "../src/classify-scope.ts";

describe("classifyScope", () => {
  test("absolute /Users path -> project", () => {
    const r = classifyScope({
      skillContent: "Use the script at /Users/marian/work/argus/scripts/foo.ts",
      skillName: "edit-foo",
    });
    expect(r.scope).toBe("project");
    expect(r.reasons.some((s) => s.includes("/Users/"))).toBe(true);
  });

  test("absolute /home path -> project", () => {
    const r = classifyScope({
      skillContent: "/home/argus/.argus/cost-tracker.toml controls thresholds.",
    });
    expect(r.scope).toBe("project");
    expect(r.reasons.some((s) => s.includes("/home/"))).toBe(true);
  });

  test("@our-org/* import -> project", () => {
    const r = classifyScope({
      skillContent: 'import { foo } from "@our-org/utils";',
      skillName: "wire-utils",
    });
    expect(r.scope).toBe("project");
    expect(r.reasons.some((s) => s.includes("@our-org/"))).toBe(true);
  });

  test("git remote url -> project", () => {
    const r = classifyScope({
      skillContent: "Push to git@github.com:our-org/argus.git",
    });
    expect(r.scope).toBe("project");
  });

  test("specific run_id pattern -> project", () => {
    const r = classifyScope({
      skillContent: "When run_id=run-2026-05-03-abc123 fails, do X.",
    });
    expect(r.scope).toBe("project");
  });

  test("generic TDD content with no anchors -> user", () => {
    const r = classifyScope({
      skillContent:
        "When implementing a feature, always write the failing test first. " +
        "Run the test, confirm it fails for the expected reason, then implement. " +
        "Re-run the test, confirm it passes, then refactor.",
      skillName: "tdd-discipline",
    });
    expect(r.scope).toBe("user");
  });

  test("generic merge-conflict skill -> user", () => {
    const r = classifyScope({
      skillContent:
        "When you encounter a merge conflict during rebase, prefer to keep the " +
        "incoming side and use git checkout --theirs followed by a verification run.",
      skillName: "merge-conflict-recipe",
    });
    expect(r.scope).toBe("user");
  });

  test("generic test-failure trigger -> user", () => {
    const r = classifyScope({
      skillContent:
        "Trigger: when test fails with TimeoutError. " +
        "Step 1: read the assertion. Step 2: increase the timeout if it's network-bound.",
    });
    expect(r.scope).toBe("user");
  });

  test("framework-agnostic refactor recipe -> user", () => {
    const r = classifyScope({
      skillContent:
        "Use the strangler-fig pattern: introduce a facade, route 1% of traffic " +
        "to the new path, keep the old path warm, expand gradually.",
    });
    expect(r.scope).toBe("user");
  });

  test("empty content -> project (safer fallback)", () => {
    const r = classifyScope({ skillContent: "" });
    expect(r.scope).toBe("project");
  });

  test("mixed content (one absolute path) pulls to project", () => {
    const r = classifyScope({
      skillContent:
        "When implementing TDD, write the failing test first. " +
        "In our project the entry point is /Users/marian/work/argus/scripts/cli.ts.",
    });
    // Single piece of evidence pulls to project per the AND-of-evidence rule.
    expect(r.scope).toBe("project");
  });

  test("specific package name (argus-recovery) -> project", () => {
    const r = classifyScope({
      skillContent: 'Run "argus-recovery ralph-cap" before any other Stop-hook check.',
    });
    expect(r.scope).toBe("project");
  });

  test("OMC_CURRENT_RUN_ID env var ref -> project", () => {
    const r = classifyScope({
      skillContent: "Read OMC_CURRENT_RUN_ID from env to identify the active run.",
    });
    expect(r.scope).toBe("project");
  });

  test("reasons[] is non-empty for project classifications", () => {
    const r = classifyScope({
      skillContent: "Edit /Users/marian/.argus/secrets.env to add the new webhook.",
    });
    expect(r.scope).toBe("project");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  test("reasons[] for user classifications notes 'no project anchors'", () => {
    const r = classifyScope({
      skillContent: "Recipe: when retrying a flaky network call, use exponential backoff.",
    });
    expect(r.scope).toBe("user");
    expect(r.reasons.some((s) => s.toLowerCase().includes("no"))).toBe(true);
  });

  test("relative path ./scripts/foo.ts is NOT a project anchor by itself", () => {
    const r = classifyScope({
      skillContent: "Edit ./scripts/foo.ts and re-run the suite.",
    });
    // ./ paths are common across projects; not a strong enough signal.
    expect(r.scope).toBe("user");
  });
});
