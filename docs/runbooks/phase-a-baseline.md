# Phase A Baseline — Runbook

Living log of the Phase A install on macOS. Append findings as you go;
do NOT delete history. Future-you (and the VPS phase) reads this.

## Environment

- macOS version: <fill in>
- Homebrew version: <fill in>
- Apple Silicon or Intel: <fill in>
- Mac model: <fill in>

## Status

- [ ] Task 1: bootstrap
- [ ] Task 2: brew packages
- [ ] Task 3: OMC install + setup
- [ ] Task 4: OMC_STATE_DIR + omc doctor
- [ ] Task 5: clawhip install
- [ ] Task 6: Discord webhook
- [ ] Task 7: clawhip config
- [ ] Task 8: hook bridge
- [ ] Task 9: launchd plists
- [ ] Task 10: daemons up
- [ ] Task 11: smoke test
- [ ] Task 12: findings + commit

## Findings (chronological)

(Append below as you complete each task. Format: `### YYYY-MM-DD HH:MM — Task N: <one-line summary>` then prose.)

### 2026-05-03 HH:MM — Task 2: brew packages installed

- tmux: <version>
- node: <version>
- cargo: <version>
- cloudflared: <version> (installed but unused in Phase A; reserved for Phase B+)

Notes: <anything that surprised you>

### 2026-05-03 HH:MM — Task 3: OMC installed

- OMC version: <output of `omc --version`>
- Claude CLI version: <output of `claude --version`>
- omc doctor: <pass/fail summary>

Notes: <any prompts that surprised you during omc setup>
