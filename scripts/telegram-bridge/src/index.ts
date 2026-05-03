import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type ChatIds, Dispatcher } from "./dispatcher.ts";
import { GateWatcher } from "./gate-watcher.ts";
import { OutboundQueue } from "./queue.ts";
import { render } from "./render.ts";
import { buildApp, makeLog } from "./server.ts";
import { TelegramClient } from "./telegram.ts";

if (import.meta.main) {
  const log = makeLog();

  const queueDbPath =
    process.env.QUEUE_DB_PATH ?? `${process.env.HOME}/.argus/state/bridge-queue.sqlite`;
  mkdirSync(dirname(queueDbPath), { recursive: true });
  const queue = new OutboundQueue(queueDbPath);

  const port = Number(process.env.BRIDGE_PORT ?? 9501);
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.error("TELEGRAM_BOT_TOKEN is required");
    process.exit(1);
  }
  const telegram = new TelegramClient(token);

  const chatIds: ChatIds = {
    info: requireChatId("TELEGRAM_CHAT_ID_INFO"),
    warn: requireChatId("TELEGRAM_CHAT_ID_WARN"),
    page: requireChatId("TELEGRAM_CHAT_ID_PAGE"),
    critical: requireChatId("TELEGRAM_CHAT_ID_CRITICAL"),
    gates: requireChatId("TELEGRAM_CHAT_ID_GATES"),
  };

  const gatesDir = process.env.OMC_GATES_DIR ?? `${process.env.HOME}/.claude/omc/gates`;
  mkdirSync(gatesDir, { recursive: true });

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  const app = buildApp({
    queue,
    log,
    telegram,
    gatesDir,
    chatIds,
    expectedSecret,
  });

  const server = Bun.serve({ port, hostname: host, fetch: app.fetch });
  log.info({ port: server.port, host }, "argus-telegram-bridge listening");

  const stopController = new AbortController();

  const dispatcher = new Dispatcher({
    queue,
    telegram,
    render,
    log,
    chatIds,
  });
  const dispatcherPromise = dispatcher.run(stopController.signal);

  const gateWatcher = new GateWatcher({ gatesDir, queue, log });
  await gateWatcher.start(stopController.signal);
  log.info({ gatesDir }, "gate-watcher started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    // Wait for in-flight HTTP requests to drain before tearing down state.
    // Closes the race where a clawhip POST arriving exactly at SIGTERM could
    // be killed mid-enqueue.
    await server.stop(true);
    stopController.abort();
    await gateWatcher.stop();
    await dispatcherPromise;
    queue.close();
    log.info("clean exit");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function requireChatId(name: string): number {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer chat id, got: ${v}`);
  }
  return n;
}
