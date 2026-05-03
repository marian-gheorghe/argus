# systemd unit templates

Jinja2 templates for the `--user` systemd units that run the Argus stack on
Linux (Ubuntu 24.04). Rendered by `ansible/roles/argus_stack/tasks/services.yml`
into `~argus/.config/systemd/user/`.

| File | Mirrors | Service |
|---|---|---|
| `clawhip.service.j2`        | `launchd/com.argus.clawhip.plist`        | clawhip observability sidecar |
| `omc-wait.service.j2`       | `launchd/com.argus.omc-wait.plist`       | OMC long-poll waiter |
| `telegram-bridge.service.j2`| `launchd/com.argus.telegram-bridge.plist`| Telegram bridge |
| `watchdog.service.j2`       | `launchd/com.argus.watchdog.plist`       | Health checks + dead-man |
| `recovery.service.j2`       | `launchd/com.argus.recovery.plist`       | Recovery HTTP serve |

## Notes

- All units run as `--user` (no `User=` directive); ownership is implicit from
  the `systemctl --user` invocation context.
- `loginctl enable-linger argus` is set by `argus_user` role so units run
  without an interactive login.
- Watchdog uses `Type=notify` + `WatchdogSec=60` + `Restart=on-watchdog`. The
  Bun runtime calls `systemd-notify WATCHDOG=1` once per successful check
  loop (see `scripts/watchdog/src/index.ts` `makeSdNotify`); a missed tick
  for 60s makes systemd kill+restart the process. This is the Linux
  equivalent of launchd's coarser `KeepAlive=true`.
- Hardening directives (`NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, `ReadWritePaths=`, `PrivateTmp`) ship in every
  unit. The launchd plists don't carry equivalent sandboxing on Mac, but on
  Linux it's free to add.
- Logs append to `~argus/.argus/logs/<service>.{out,err}.log` matching the
  Mac plist convention. journald still receives stderr/stdout via the unit
  default; use `journalctl --user -u <service>` for the canonical view.
