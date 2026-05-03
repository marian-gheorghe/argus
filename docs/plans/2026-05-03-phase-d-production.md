# Phase D — Production Rollout & First Real Workload

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development if executing in this session). Phase D is operational, not implementation-heavy — many "tasks" are observations and decisions, not code.

**Prerequisites:** Phase C merged, 72h dry-run PASS, recovery matrix all six scenarios green, VPS cutover dry-run completed.

**Goal:** Move Argus from "internal validation" to "actually doing work I'd otherwise spend a week on." Submit a real A or C job, observe how it behaves, capture what actually breaks under genuine workload, iterate. The success criterion is qualitative: **at the end of Phase D, you trust the system enough to start Argus and walk away for 48+ hours without anxiety.**

**Architecture:** No new components. Phase D is the operational graduation. The only deliverables are runbooks, observation logs, success-metric reports, and small bug-fix iterations on the existing components.

**Out of scope for Phase D:**
- Multi-tenancy / multi-user.
- Web UI / dashboard.
- Anything from design §11.3's "v1 explicitly does NOT include" list.

---

## Pre-flight checklist

Before submitting any real workload, all of these must be true. Do NOT skip — Phase D's value is precisely in the rigor of the pre-flight.

- [ ] Phase C merged on `main`. No uncommitted changes anywhere.
- [ ] All five daemons running (clawhip, omc-wait, telegram-bridge, watchdog, cloudflared). `launchctl list | grep com.argus` (Mac) or `systemctl --user status` (VPS) shows all green for ≥7 days.
- [ ] Last 7 days of `~/.argus/logs/*.err.log` show no UNCAUGHT errors. Caught + handled errors (e.g., a transient Telegram 429 retried successfully) are fine.
- [ ] sqlite queue depths: `bun run scripts/telegram-bridge/src/cli.ts queue-status` reports zero pending (or at most a handful, dispatching).
- [ ] `clawhip status` returns ok. Watchdog status: `bun run scripts/watchdog/src/cli.ts status` returns all checks healthy.
- [ ] Telegram smoke: `clawhip send --event "argus.preflight" --message "Phase D pre-flight"` arrives in `#runs-info` (and any tier-routing has been re-verified — info, warn, page, critical chats all received their respective synthetic events).
- [ ] OMC tier-routing pinned in `policy.toml` matches design §7.4. `omc team --dry-run "..."` shows expected agent/tier assignments.
- [ ] You've decided the **first real workload** (see Task 1 below). It's small enough to be a meaningful test (≤3 days), large enough that completing it has real value to you.
- [ ] You've decided the **billing mode** for the first real workload (Max20 default; switch to API only if cost-ceiling experimentation is part of the goal).
- [ ] You've notified anyone affected (collaborators on the target repo, on-call rotations, etc.) that an autonomous agent will be working on the codebase during a specified window.
- [ ] Backups: most recent `~/.claude/omc/runs/` snapshot is < 24h old. (If on VPS: most recent Hetzner volume snapshot ditto.)
- [ ] You have ~30 minutes available to babysit the first 30 minutes of the run. After that, you can sleep.

---

## Task 1: Choose the first real workload

**Why:** The right first workload is large enough to prove autonomy but bounded enough that worst-case-rollback isn't catastrophic. Migrations (C) tend to have stronger autonomy guarantees because of shadow comparison, but greenfield (A) is simpler to rollback (just delete the repo).

**Decision matrix** — pick one row:

| Profile | Risk | Recommended for first workload |
|---|---|---|
| Greenfield, small (1-day, single service) | Low rollback cost | ✅ Best first choice |
| Greenfield, large (3-day, multi-service) | Bounded but real time cost | OK after first small one |
| Migration, small (rename/refactor on test repo) | Bounded — harness gates | ✅ Strong second choice |
| Migration, large (real prod codebase) | High — defer until 2+ small runs are PASS | ❌ Not for Phase D |

**Output of Task 1:** a 1-paragraph problem statement and a `~/.claude/omc/runs/argus-first-real-workload.brief.md` file capturing scope, success criteria, billing mode, expected duration, and what you'll do with the result.

This brief is the contract. Do NOT change it once submitted (in line with the gate model — the architect will turn it into a PRD at gate 1, you approve, then it's locked).

---

## Task 2: Submit + observe the first 30 minutes

**Why:** First 30 min is when most failures surface (config drift, env-var mismatches, hook misregistration). Past 30 min, recovery automation handles most issues.

**Steps:**

1. From inside the relevant target repo, submit:

```bash
omc team --billing=max20 "$(cat ~/.claude/omc/runs/argus-first-real-workload.brief.md)"
```

2. **Observe** in this order, on a 5-minute cadence:
   - `#runs-info` Discord: should see `session.started`, `agent.started` (multiple), `git.commit` events flowing.
   - `#argus-gates` Telegram: should be silent until gate 1 fires (typically 30-90 min in for greenfield A).
   - `~/.argus/logs/*.err.log`: tail with `tail -f` in a side terminal. Any non-empty error log is a watch item.
   - `tmux a -t <run-id>-leader`: detach back out (`Ctrl-b d`) without sending input — just confirming the session exists and looks alive.

3. **Document the first 30 minutes** in a fresh `docs/runbooks/phase-d-first-workload.md` file. Format: 5-minute timestamps, what was visible at each timestamp, anything anomalous.

4. **At the 30-min mark, decide:**
   - All looking nominal → walk away. Phase D continues unattended.
   - Any errors that recovery automation didn't catch → halt with `omc cancel <run-id>`, debug, fix, re-submit.
   - Major architectural smell from agent activity (going down a wrong path early) → halt, refine the brief, re-submit. (This is information, not failure.)

---

## Task 3: Approve gate 1 (PRD) from phone

**Why:** This is the moment-of-truth for the autonomy promise. You should be doing this from somewhere not-at-your-desk: bed, coffee shop, walk.

**Steps:**

1. Wait for Telegram notification.
2. Read the PRD summary in the message body (~10 sec).
3. Open the artifact link if you want depth (~1-2 min).
4. Tap `✅ Approve` or `❌ Reject + comment` (with a one-line reason) or `⏸ Defer 4h`.
5. **Verify** within 60 sec the next phase starts: `#runs-info` should show `phase.transitioned` and new `agent.started` events.

**Document the approval experience in the runbook:** how long it took you to read+decide, whether the message format was useful or noise, anything you'd change about the UX.

---

## Task 4: Mid-run intervention discipline

**Why:** Once the build phase is rolling, the system *should* run unattended. Resist the urge to micromanage.

**Rules of intervention:**

1. **Read-only check-ins are fine.** Open `#runs-info`. Tail logs. SSH in and `omc status <run-id>`. None of these affect the run.
2. **Do not edit code in the worker worktrees.** That breaks the agent's mental model and causes silent merge conflicts later.
3. **Do not preempt the agent's task ordering.** If you think it's working on the wrong thing first, your gate 1 PRD approval was the place for that.
4. **Use `/pause` if you need to think before letting it continue.** Don't `/cancel` over uncertainty — `/pause` keeps state, `/cancel` discards.
5. **Page-tier alerts are mandatory to action.** If `#argus-page` lights up, look NOW. The system is trying to tell you something it couldn't auto-resolve.

**Document each intervention** (or non-intervention with rationale) in the runbook. The pattern of interventions across Phase D is itself a signal — high-intervention runs mean the system isn't actually autonomous yet.

---

## Task 5: Approve final PR + observe merge

**Why:** Gate N is the GitHub PR review. Same UX as code review on any PR, just from a phone. The autonomy promise *includes* trusting the harness — you're sanity-checking, not line-by-line auditing.

**Steps:**

1. Telegram notifies on PR open with link.
2. Open in GitHub mobile. Skim the diff (~3 min). Look for: anything that looks unsafe (deletes you didn't expect, secrets accidentally committed, dependencies you don't recognize). If nothing red, approve.
3. Watch the merge land in `#runs-info`.
4. Receive run-completion notification.

**Capture in runbook:** time-from-PR-open to merge-landed; anything that surprised you in the diff; whether the agent's commit messages were useful (they should be — `/learner` may have written skills about commit-message hygiene by now).

---

## Task 6: Post-run retrospective

**Why:** This is how the system learns *between* runs. The retro is structured.

**Files:** create `docs/runbooks/retros/<run-id>.md`.

**Sections:**

1. **Workload summary:** brief, billing mode, duration, cost.
2. **Outcome:** done/partial/failed; objective evidence (passing tests, working endpoints, etc.).
3. **What went well:** specifically. Not "agents did good." More like "the harness caught a behavior divergence at fan-out batch 3 that I would have missed."
4. **What broke (and what was the recovery):** every anomaly, even ones recovery automation handled silently. Look at logs after the fact for these.
5. **What I had to do that I shouldn't have had to:** the friction list. Each one is a candidate for a Phase E improvement.
6. **What `/learner` produced:** count of new skills (project + user scope); spot-check 2-3 of them for actual usefulness vs. AI slop.
7. **Cost retrospective (if API mode):** vs. estimate, breakdown by tier and phase.
8. **Recommend Yes/No for repeating with similar workloads:** with reasoning.

---

## Task 7: Iterate on at least one identified issue before next run

**Why:** Phase D is a learning loop. Don't submit the second real workload until you've at least made *some* improvement in response to the first run's friction list.

**Process:**

1. Pick the highest-friction item from Task 6.
2. Open a new worktree (`.worktrees/phase-d-fix-<short-name>` on `phase-d/fix-<short-name>` branch).
3. Apply the same TDD + verification discipline as earlier phases.
4. Merge to main.
5. Re-run preflight checks (Task 0 above).
6. Submit the next real workload.

If you find yourself unable to even articulate the highest-friction item, the system might already be good enough — go to Task 8.

---

## Task 8: Promotion criteria — "Argus operational"

Phase D is **complete and Argus is operational** when ALL of these are true after at least 3 real workloads:

- [ ] You've slept through ≥1 full night with an active run, woke up, found nothing broken (or only nominal page-tier events that recovery handled).
- [ ] Total human time per run is ≤30 min (excluding writing the brief).
- [ ] You can articulate the failure modes you DON'T worry about anymore (because you've seen them recover) and the ones that still keep you watching (those become the Phase E backlog).
- [ ] The retro skill library (`~/.omc/skills/`) has compounded — you can point to ≥3 skills that are objectively useful that came from `/learner` across runs.
- [ ] Your aggregate cost per "useful work day" is sustainable (Max20 absorbing it, or API-mode burn within target).
- [ ] You're willing to recommend the system to one specific other person whose workflow you understand.

When all six are true, write a final entry in `docs/runbooks/argus-operational.md` declaring promotion. Decide explicitly whether to:
- Move to Phase E (post-v1 backlog: dashboard, multi-user, semantic skills, etc.).
- Keep using as-is for an extended period (no Phase E, just real work).
- Sunset (didn't pan out). Capture lessons.

---

## Phase D definition of done

- [ ] At least 3 real workloads completed.
- [ ] At least 1 unattended overnight run.
- [ ] At least 1 retro performed and at least 1 friction-driven improvement merged.
- [ ] Pre-flight checklist successfully run before each workload.
- [ ] `argus-operational.md` written with one of the three explicit dispositions.

---

## What comes after Phase D

If you reach "Argus operational" — congratulations. The post-v1 backlog (deferred from design §11.3) is now genuinely candidate for *some* of it:

- Web dashboard (only if you find yourself wanting `omc tail <run-id>` from a non-SSH context regularly).
- Multi-user (only if you bring on collaborators).
- Semantic skill search (only after `~/.omc/skills/` exceeds ~50 skills).
- PagerDuty or SMS escalation (only if Telegram + Discord proves insufficient — has not, in v1).
- Slack integration (only if your team uses Slack and asks).

Resist building these speculatively. Argus's v1 design is intentionally narrow; "robust long-term" is about the components actually in scope, not about adding more.
