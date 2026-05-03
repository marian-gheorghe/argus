/**
 * Skill trigger collision-check (design §9.5).
 *
 * Pure function: given a newly-extracted skill and the set of existing
 * skills, find any whose triggers overlap. The contract is that
 * `/learner` may produce a skill whose trigger phrasing is too close
 * to an existing skill's; we want to flag those for the operator to
 * either merge into the existing skill or rephrase the new trigger.
 *
 * Similarity is the **max** of three metrics — see triggerSimilarity()
 * for the full breakdown. In summary:
 *   1. Levenshtein-normalised on raw lowercased text (char-level
 *      near-duplicates).
 *   2. Token-stem Jaccard (suffix-drift + reorderings).
 *   3. Sorted-stem Levenshtein (longer reorderings + extra words).
 *
 * A pair (newTrigger, existingTrigger) is a collision iff
 * `similarity > 0.7`. A `newSkill / existingSkill` pair is a collision
 * iff at least one trigger pair crosses the threshold; we report
 * *every* crossing pair so the operator can see how the overlap looks.
 *
 * The Levenshtein impl is the standard 2-row DP — kept inline (~20
 * lines) to avoid a tiny dep.
 */

const COLLISION_THRESHOLD = 0.7;

export interface ExistingSkill {
  path: string;
  name: string;
  triggers: string[];
}

export interface CollisionInput {
  newSkill: { name: string; triggers: string[] };
  existing: ExistingSkill[];
}

export interface CollisionOverlap {
  trigger: string;
  existingTrigger: string;
  similarity: number;
}

export interface Collision {
  with: ExistingSkill;
  overlap: CollisionOverlap[];
}

export function detectCollisions(input: CollisionInput): Collision[] {
  const collisions: Collision[] = [];
  for (const existing of input.existing) {
    const overlap: CollisionOverlap[] = [];
    for (const t of input.newSkill.triggers) {
      for (const e of existing.triggers) {
        const sim = triggerSimilarity(t, e);
        if (sim > COLLISION_THRESHOLD) {
          overlap.push({ trigger: t, existingTrigger: e, similarity: round(sim) });
        }
      }
    }
    if (overlap.length > 0) {
      collisions.push({ with: existing, overlap });
    }
  }
  return collisions;
}

/**
 * Returns the per-character Levenshtein edit distance between `a` and
 * `b`. Time O(|a|·|b|), space O(min(|a|,|b|)).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure b is the shorter so the row buffer stays small.
  let s = a;
  let t = b;
  if (s.length < t.length) {
    const tmp = s;
    s = t;
    t = tmp;
  }
  const m = s.length;
  const n = t.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const sChar = s.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = sChar === t.charCodeAt(j - 1) ? 0 : 1;
      // Defaults populated above; bounds are i:[1..m], j:[1..n] so
      // prev[j], prev[j-1], curr[j-1] are all defined.
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n] ?? Math.max(m, n);
}

/**
 * Combined trigger similarity in [0..1]. Returns the max of three
 * metrics, each robust to a different kind of near-duplication:
 *
 *   1. **Levenshtein-normalised** on raw lowercased text. Catches
 *      character-level near-duplicates ("handle auth error" /
 *      "handle auth errors").
 *   2. **Token-stem Jaccard.** Tokens are stemmed (drop trailing
 *      `-s`, `-es`, `-ing`, `-ed`, `-er`) so "handling" / "handle"
 *      collapse to the same root. Then `|A ∩ B| / |A ∪ B|`. Catches
 *      reorderings + suffix drift ("auth handling" / "handle auth").
 *      Only counted if Jaccard >= 0.5; below that a single shared
 *      filler word between unrelated triggers would over-report.
 *   3. **Sorted-stem Levenshtein.** Tokens are sorted + stemmed,
 *      rejoined, then Levenshtein-compared. Backstop for
 *      reorderings-with-extra-words.
 *
 * All metrics are case-insensitive. The intentional combination
 * trades a small amount of false-positive risk for catching the most
 * common real /learner re-extraction failure mode: same idea,
 * different phrasing.
 */
export function triggerSimilarity(a: string, b: string): number {
  const aL = a.toLowerCase().trim();
  const bL = b.toLowerCase().trim();
  if (aL === bL) return 1.0;
  const maxLen = Math.max(aL.length, bL.length);
  const lev = maxLen === 0 ? 0 : 1 - levenshtein(aL, bL) / maxLen;

  const aTok = tokenize(aL);
  const bTok = tokenize(bL);
  const aStem = new Set(aTok.map(stem));
  const bStem = new Set(bTok.map(stem));
  const inter = intersectSize(aStem, bStem);
  const union = aStem.size + bStem.size - inter;
  const jac = union === 0 ? 0 : inter / union;
  const jacEffective = jac >= 0.5 ? jac : 0;

  // Sorted-stem Levenshtein: rejoin sorted stems and re-score.
  const aSorted = [...aTok.map(stem)].sort().join(" ");
  const bSorted = [...bTok.map(stem)].sort().join(" ");
  const sortedMaxLen = Math.max(aSorted.length, bSorted.length);
  const sortedLev = sortedMaxLen === 0 ? 0 : 1 - levenshtein(aSorted, bSorted) / sortedMaxLen;

  return Math.max(lev, jacEffective, sortedLev);
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Cheap English-suffix stripper. Not linguistically rigorous — just
 * normalises the most common trigger-phrase variants ("handling"
 * vs "handle", "errors" vs "error", "queued" vs "queue"). We
 * deliberately don't bring in a Porter stemmer dep for this.
 */
function stem(token: string): string {
  if (token.length <= 3) return token;
  const suffixes = ["ing", "ed", "es", "er", "s"];
  for (const sfx of suffixes) {
    if (token.length > sfx.length + 2 && token.endsWith(sfx)) {
      return token.slice(0, -sfx.length);
    }
  }
  return token;
}

function intersectSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
