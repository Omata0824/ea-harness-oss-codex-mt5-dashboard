import http from "node:http";
import express from "express";
import { loadConfig, resolveRoot } from "./config.js";
import { createApiRouter } from "./api/routes.js";
import { WebSocketHub } from "./api/websocket.js";
import { PipelineOrchestrator } from "./orchestrator/pipeline.js";
import { StateStore } from "./orchestrator/state.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const app = express();
  const store = new StateStore();
  await store.ensureWorkspace();
  await store.recoverInterruptedProjects();

  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(resolveRoot("dashboard")));

  const server = http.createServer(app);
  const hub = new WebSocketHub(server);
  const orchestrator = new PipelineOrchestrator(store, hub);

  app.use("/api", createApiRouter({ store, orchestrator }));
  app.get(/.*/, (_req, res) => {
    res.sendFile(resolveRoot("dashboard", "index.html"));
  });

  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = error instanceof Error ? error.message : "Unknown server error";
      res.status(500).json({ error: message });
    },
  );

  server.listen(config.server.port, config.server.host, () => {
    console.log(`EA Harness OSS listening on http://${config.server.host}:${config.server.port}`);
  });
}

void main();
