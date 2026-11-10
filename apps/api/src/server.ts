import { initTelemetry, shutdownTelemetry } from "./lib/telemetry.js";
initTelemetry();
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createQueue, createStorage } from "./lib/aws.js";
import { httpRagClient } from "./routes/query.js";

const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL);
const app = await buildApp({
  cfg,
  pool,
  storage: createStorage(cfg),
  queue: createQueue(cfg),
  rag: httpRagClient(cfg.RAG_ENGINE_URL),
});

const shutdown = async () => {
  app.log.info("shutting down");
  await app.close();
  await pool.end();
  await shutdownTelemetry();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: cfg.PORT });
// Planificador de conectores (CON-01): sincroniza en segundo plano con lease en BD (seguro con varias réplicas).
app.connectors.start();
// Runs que quedaron QUEUED/RUNNING antes de un reinicio continúan desde su último paso persistido.
app.workflows
  .resumePending()
  .then((n) => n && app.log.info({ runs: n }, "resumed workflow runs"))
  .catch((err) => app.log.error({ err }, "workflow resume failed"));
