# Argus Knowledge

Knowledge accumulation discipline (design §9). Implements:

- **5.1 `/learner` cadence** — Stop-hook that sets `manifest.next_prompt_prepend = "/learner"` at every phase boundary.
- **5.2 Skill-scope classifier + collision check** — orchestrator that, after `/learner` produces a new skill, classifies it as `project`-scope or `user`-scope and detects trigger overlap with existing skills.
- **5.3 Notepad 500-line cap + summarizer** — PostToolUse hook that compresses `notepad.md` once it grows past 500 lines, archiving the original.

- **Runtime:** Bun
- **Lang:** TypeScript (strict)
- **Storage:** atomic JSON at `$OMC_STATE_DIR/runs/<run_id>/manifest.json` with sidecar `.lock` file (mirror of `scripts/recovery/src/manifest.ts`)
- **Validation:** zod
- **Tests:** `bun test`

## Entrypoints

`argus-knowledge` is a single CLI with sub-commands:

```
argus-knowledge learner-cadence                # Stop hook
argus-knowledge learner-postprocess <skill>    # post-process a /learner output
argus-knowledge notepad-cap                    # PostToolUse hook
```

The Stop-hook wrapper at `~/.argus/knowledge-stop-hook.sh` calls `learner-cadence`.
The PostToolUse-hook wrapper at `~/.argus/knowledge-posttool-hook.sh` calls `notepad-cap`.
`learner-postprocess` is currently invoked manually after `/learner` produces a new skill (Phase D will automate via a file-watcher or by extending OMC's `/learner` skill itself).

## Develop

```
bun install
bun test            # run tests
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
```

## Manifest schema

`manifest.ts` is a slim duplicate of `scripts/recovery/src/manifest.ts`. Both
modules need the same atomic-write + lock semantics for `next_prompt_prepend`,
and Phase C ships them side-by-side. **TODO (Phase C+):** extract to a shared
`argus-state` package so the schema lives in one place. See the file header
for the same TODO in code form.

## Cross-process semantics

All writes that touch shared state (`manifest.json`, the destination
`SKILL.md`, the notepad replacement, the archived notepad) use the same
atomic-write pattern: write to `<final>.tmp.<pid>`, `fsync`, `rename(2)`. The
manifest specifically also serialises updates through a sidecar
`manifest.lock` file (open with `O_EXCL`, spin-wait up to 2s, throw on
timeout) so concurrent writers (e.g., recovery's Stop hook and knowledge's
Stop hook firing back-to-back) cannot corrupt each other.

## Hooks

- **Stop hook** (`learner-cadence`) — crash-resistant, exit 0 always. If
  `OMC_CURRENT_RUN_ID` or `OMC_CURRENT_PHASE` is missing, no-ops silently.
- **PostToolUse hook** (`notepad-cap`) — crash-resistant, exit 0 always. If
  the notepad is missing or under the line cap, no-ops silently.
