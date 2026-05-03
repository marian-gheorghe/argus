# Argus — Ansible VPS Provisioning

Declarative, idempotent provisioning of a fresh Ubuntu 24.04 Hetzner CX32 into
a full Argus stack. Mirrors `scripts/install-mac.sh` for Linux.

## Layout

```
ansible/
  ansible.cfg                       inventory + ssh defaults
  requirements.yml                  galaxy collections (community.general, ansible.posix)
  inventory/
    hosts.yml.example               operator copies to hosts.yml (gitignored)
    group_vars/
      argus_vps.yml.example         non-secret config (gitignored when filled)
      argus_vps.vault.yml.example   vault template (gitignored when filled)
  playbooks/
    00-bootstrap.yml                root-as: hardening + create argus user
    10-stack.yml                    argus-as: install full stack
    20-cutover.yml                  Mac -> VPS state migration
    99-verify.yml                   health assertions
  roles/
    common/                         tmux, git, jq, timezone, NTP
    hardening/                      UFW, fail2ban, sysctl, unattended-upgrades
    argus_user/                     create argus + SSH keys
    argus_stack/                    OMC, clawhip, bridge, watchdog, recovery, cost-tracker
    nginx/                          nginx + Let's Encrypt reverse proxy
    tailscale/                      tailscale install + auth
  molecule/default/                 docker-driver smoke (best-effort)
```

## Pre-flight

1. **Install Ansible locally.** `pipx install ansible-core ansible-lint`.
2. **Install collections.** `ansible-galaxy collection install -r requirements.yml`.
3. **Provision the VPS.** Hetzner Cloud Console → CX32, Ubuntu 24.04, your SSH key
   delivered via cloud-init. Note the public IPv4.
4. **Configure inventory.**
   ```bash
   cp inventory/hosts.yml.example inventory/hosts.yml
   $EDITOR inventory/hosts.yml          # set ansible_host
   cp inventory/group_vars/argus_vps.yml.example inventory/group_vars/argus_vps.yml
   $EDITOR inventory/group_vars/argus_vps.yml
   ```
5. **Configure secrets via ansible-vault.**
   ```bash
   cp inventory/group_vars/argus_vps.vault.yml.example \
      inventory/group_vars/argus_vps.vault.yml
   $EDITOR inventory/group_vars/argus_vps.vault.yml          # fill placeholders
   ansible-vault encrypt inventory/group_vars/argus_vps.vault.yml
   ```
   Decrypt to edit: `ansible-vault edit ...`. Re-key: `ansible-vault rekey ...`.
6. **Connectivity test.** `ansible -i inventory/hosts.yml argus_vps -m ping -u root`.

## Run order

```bash
# 1. Bootstrap as root: hardening + create argus user.
ansible-playbook playbooks/00-bootstrap.yml -u root --ask-vault-pass

# 2. Install the stack as the argus user.
ansible-playbook playbooks/10-stack.yml -u argus --ask-vault-pass

# 3. (Optional) Cutover state from Mac -> VPS.
ansible-playbook playbooks/20-cutover.yml -u argus --ask-vault-pass

# 4. Verify health.
ansible-playbook playbooks/99-verify.yml -u argus --ask-vault-pass
```

`ANSIBLE_VAULT_PASSWORD_FILE=~/.argus-vault-pass` skips `--ask-vault-pass`.

## Cutover sequence

`20-cutover.yml` orchestrates a one-shot Mac → VPS migration. It is
idempotent (re-running with the same `argus_cutover_phase` is a no-op for
already-completed steps) and reversible (the Mac launchd plists remain on
disk, only unloaded — `launchctl bootstrap` re-loads them).

```bash
# Phase 1: stop launchd daemons on Mac.
ansible-playbook playbooks/20-cutover.yml -e argus_cutover_phase=stop_source

# Phase 2: rsync state Mac -> VPS over SSH.
ansible-playbook playbooks/20-cutover.yml -e argus_cutover_phase=rsync

# Phase 3: enable + start systemd --user units on VPS.
ansible-playbook playbooks/20-cutover.yml -e argus_cutover_phase=start_target

# Phase 4: verify.
ansible-playbook playbooks/20-cutover.yml -e argus_cutover_phase=verify

# Or run all four in sequence:
ansible-playbook playbooks/20-cutover.yml -e argus_cutover_phase=all
```

**Reverting** (return primary to Mac): stop the VPS systemd units
(`systemctl --user stop clawhip omc-wait telegram-bridge watchdog recovery`),
then `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.argus.*.plist` on
the Mac. State on the VPS remains intact for a future re-cutover.

## Trust model

- The `argus` user is a service user. It has no sudo. Operators SSH in as their
  own login (managed out of band) and use sudo for ops work.
- All Argus daemons run as `--user` systemd units owned by `argus`, with linger
  enabled so they survive logout.
- Secrets land in `~argus/.argus/secrets.env` (mode 0600) — same path as on Mac.
- Tailscale provides the SSH overlay; UFW only allows port 22 from
  `100.64.0.0/10` (CGNAT).
- Public ingress is HTTPS-only via nginx + Let's Encrypt, on ports 80/443.

## Adding a new node

1. Add an entry under `argus_vps.hosts` in `inventory/hosts.yml`.
2. Re-run `00-bootstrap.yml` and `10-stack.yml`. Ansible's idempotency means
   existing nodes are no-ops; new nodes get the full treatment.

## molecule

`molecule/default/molecule.yml` runs a docker-driver smoke against
`ubuntu:24.04`. Install with `pipx install 'molecule[docker]' molecule-plugins`.

```bash
cd ansible
molecule test
```

**Limitations:** docker-in-docker can't run a real systemd `--user` instance,
tailscale needs `/dev/net/tun` (granted via `privileged: true` but still
flaky), and `cargo install clawhip` is slow. Molecule is a syntax + per-role
smoke, not a full-stack validator. **Full validation requires a real Hetzner
VPS dry run** — track that in the runbook.

## Troubleshooting

- **"Failed to connect to the host via ssh".** First-run only: ensure the
  Hetzner cloud-init key matches the operator's `~/.ssh/id_ed25519`. After
  bootstrap, switch `ansible_user` to `argus`.
- **"vault password incorrect".** `ansible-vault rekey` to set a new password,
  then update `~/.argus-vault-pass`.
- **systemd `--user` unit not starting.** Verify linger is enabled:
  `loginctl show-user argus | grep Linger`. Should be `Linger=yes`.
- **certbot fails.** DNS A record must point at the VPS *before* the playbook
  runs. Otherwise certbot's HTTP-01 challenge fails.
