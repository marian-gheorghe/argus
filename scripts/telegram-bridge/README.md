# Argus Telegram Bridge

Receives clawhip webhook events, ships them to Telegram.

- **Runtime:** Bun
- **Lang:** TypeScript (strict)
- **HTTP:** Hono
- **Storage:** `bun:sqlite` (built-in)
- **Logging:** pino (JSON in prod, pretty in dev)
- **Tests:** `bun test`

See `docs/plans/2026-05-03-phase-b-gates-and-telegram.md` for context, and
`docs/plans/2026-05-03-argus-design.md` for overall architecture.

## Develop

```
bun install
bun run dev          # watch mode
bun test             # run tests
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
```

## Run

```
bun run start
curl http://127.0.0.1:9501/health
```

Environment:
- `BRIDGE_PORT` (default 9501)
- `BRIDGE_HOST` (default 127.0.0.1)
- `LOG_LEVEL` (default info)
- `NODE_ENV=production` to switch to JSON-only logs
