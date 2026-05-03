import { Hono } from "hono";
import pino from "pino";

const log = pino({
  name: "argus-telegram-bridge",
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true } },
});

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    name: "argus-telegram-bridge",
    version: "0.1.0",
    uptime_secs: Math.round(process.uptime()),
  }),
);

export { app, log };

if (import.meta.main) {
  const port = Number(process.env.BRIDGE_PORT ?? 9501);
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
  const server = Bun.serve({ port, hostname: host, fetch: app.fetch });
  log.info({ port: server.port, host }, "argus-telegram-bridge listening");

  // Graceful shutdown — drain wired in later tasks.
  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
