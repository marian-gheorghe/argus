import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { OutboundQueue } from "./queue.ts";
import { buildApp, makeLog } from "./server.ts";

const log = makeLog();

const queueDbPath =
  process.env.QUEUE_DB_PATH ?? `${process.env.HOME}/.argus/state/bridge-queue.sqlite`;
mkdirSync(dirname(queueDbPath), { recursive: true });
const queue = new OutboundQueue(queueDbPath);

const app = buildApp({ queue, log });

export { app, log, queue };

if (import.meta.main) {
  const port = Number(process.env.BRIDGE_PORT ?? 9501);
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
  const server = Bun.serve({ port, hostname: host, fetch: app.fetch });
  log.info({ port: server.port, host }, "argus-telegram-bridge listening");

  // Tasks 7-9 will wire dispatcher + gate-watcher into shutdown here.
  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    server.stop();
    queue.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
