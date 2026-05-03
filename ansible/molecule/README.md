# Argus — molecule scenarios

Best-effort smoke tests for the Ansible roles. Coverage is deliberately
**partial**: docker-in-docker can't run a real systemd `--user` instance,
tailscale needs `/dev/net/tun`, certbot needs an external HTTP-01 endpoint,
and `cargo install clawhip` is too slow to repeat per-CI-run. So molecule
asserts only the safe subset — `common`, `argus_user`, `hardening`.

**Full stack validation requires a real Hetzner VPS dry run.** The runbook
tracks that as a Block 6 / Block 4 follow-up item.

## Running

```bash
pipx install 'molecule[docker]' molecule-plugins
cd ansible
molecule test
```

`molecule test` runs the full lifecycle: create container, converge (apply
roles), idempotence (re-run with --diff and assert no changes), verify
(assertions), destroy.

## When this catches things

- YAML syntax regressions across the small roles.
- Missing dependencies (e.g. UFW package not installed before a UFW rule).
- Ownership / mode mistakes on files written by the role.
- Newly-broken idempotence (the second converge run flags any task that
  reports changed=true unexpectedly).

## When it doesn't

- Anything that needs systemd `--user` (clawhip / bridge / watchdog /
  recovery as systemd services).
- Anything that needs network egress to external services (cargo-build of
  clawhip from crates.io, npm install of OMC, certbot's ACME flow).
- Tailscale's `tailscale up`.

For those, run a Hetzner VPS dry run; document the wall-clock + any rough
edges in `docs/runbooks/phase-c-hardening.md` under Block 4.
