/**
 * Skill-scope classifier (design §9.2).
 *
 * Pure function: given a skill's markdown content (and optionally its
 * name), decide whether it should live in the **project** scope (under
 * the repo's `.omc/skills/`) or the **user** scope (under
 * `~/.omc/skills/`).
 *
 * Heuristics — single-evidence-pulls-to-project:
 *
 * Any of these signals -> project:
 *   - absolute file paths starting `/Users/`, `/home/`, `/var/`, `/opt/`
 *   - `@our-org/*` or `@argus/*` imports (repo-specific scopes)
 *   - git remote URLs (`git@github.com:.../...git`, `https://github.com/...`)
 *   - explicit run_id patterns (`run-...` style)
 *   - project-specific binary names (`argus-*`, `omc`, `clawhip`)
 *   - project-specific env vars (`OMC_*`, `ARGUS_*`, `CLAWHIP_*`)
 *
 * Otherwise -> user. The reasons[] list documents which signals fired
 * (or, for user classifications, that no project anchors were detected)
 * so that downstream tooling can surface a "why did we route this here?"
 * audit trail.
 *
 * Default for empty / unparseable content: **project** — it's safer to
 * scope a skill too narrowly than to leak project-specific knowledge
 * into the user-global skill set across unrelated repos.
 */

export type Scope = "project" | "user";

export interface ClassifyInput {
  skillContent: string;
  skillName?: string;
}

export interface ClassifyResult {
  scope: Scope;
  reasons: string[];
}

interface Probe {
  // A short tag used in reasons[] when this probe fires.
  label: string;
  test: (text: string) => string | null; // returns the matched substring (for reasons[]) or null
}

const PROJECT_PROBES: Probe[] = [
  {
    label: "absolute path",
    test: (t) => {
      const m = t.match(/(?:^|\s)(\/(?:Users|home|var|opt)\/[^\s)`]+)/);
      return m ? (m[1] ?? null) : null;
    },
  },
  {
    label: "scoped npm import",
    test: (t) => {
      // @our-org/, @argus/, @<inventory_hostname>/, etc. — anything that
      // looks like a private scope. Excludes well-known public scopes
      // (@types/, @biomejs/, @anthropic-ai/, @bun/) which can appear in
      // generic skills.
      const PUBLIC_SCOPES = new Set([
        "@types",
        "@biomejs",
        "@anthropic-ai",
        "@bun",
        "@vue",
        "@angular",
        "@nestjs",
      ]);
      const re = /@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*/gi;
      let m: RegExpExecArray | null;
      m = re.exec(t);
      while (m !== null) {
        const scope = m[0].split("/")[0] ?? "";
        if (!PUBLIC_SCOPES.has(scope)) {
          return m[0];
        }
        m = re.exec(t);
      }
      return null;
    },
  },
  {
    label: "git remote",
    test: (t) => {
      const m =
        t.match(/git@[a-z0-9.-]+:[a-z0-9_.-]+\/[a-z0-9_.-]+\.git/i) ??
        t.match(/https:\/\/(?:github|gitlab|bitbucket)\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+/i);
      return m ? m[0] : null;
    },
  },
  {
    label: "run_id pattern",
    test: (t) => {
      const m = t.match(/\brun-[a-z0-9-]{4,}\b/i);
      return m ? m[0] : null;
    },
  },
  {
    label: "project binary name",
    test: (t) => {
      const m = t.match(/\b(argus-[a-z][a-z-]*|omc|clawhip)\b/);
      return m ? m[0] : null;
    },
  },
  {
    label: "project env var",
    test: (t) => {
      const m = t.match(/\b(OMC_[A-Z_]+|ARGUS_[A-Z_]+|CLAWHIP_[A-Z_]+)\b/);
      return m ? m[0] : null;
    },
  },
];

export function classifyScope(input: ClassifyInput): ClassifyResult {
  const text = input.skillContent ?? "";
  if (text.trim().length === 0) {
    return {
      scope: "project",
      reasons: ["empty skill content — defaulting to project (safer fallback)"],
    };
  }

  const reasons: string[] = [];
  for (const probe of PROJECT_PROBES) {
    const hit = probe.test(text);
    if (hit !== null) {
      reasons.push(`${probe.label}: ${truncate(hit, 80)}`);
    }
  }

  if (reasons.length > 0) {
    return { scope: "project", reasons };
  }

  return {
    scope: "user",
    reasons: ["no project anchors detected (no absolute paths, scoped imports, or argus-* refs)"],
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}
