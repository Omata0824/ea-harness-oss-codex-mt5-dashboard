import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
import { detectMt5Paths, validateMt5Paths } from "../mt5/paths.js";
import { runCommand } from "../mt5/process.js";
import { loadConfig, saveConfig } from "../config.js";
import type { PipelineMode } from "../types.js";
import type { PipelineOrchestrator } from "../orchestrator/pipeline.js";
import type { StateStore } from "../orchestrator/state.js";

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readDirIfExists(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

export function createApiRouter(args: {
  store: StateStore;
  orchestrator: PipelineOrchestrator;
}) {
  const router = express.Router();

  router.get("/projects", async (_req, res, next) => {
    try {
      res.json(await args.store.listProjects());
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects", async (req, res, next) => {
    try {
      const config = await loadConfig();
      const project = await args.store.createProject({
        name: req.body?.name,
        idea: String(req.body?.idea ?? ""),
        mode: (req.body?.mode as PipelineMode | undefined) ?? config.pipeline.mode,
      });
      res.status(201).json(project);
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:id", async (req, res, next) => {
    try {
      const project = await args.store.readProject(req.params.id);
      const projectDir = args.store.projectDir(req.params.id);
      const analysisPath = path.join(projectDir, "analysis", "report.json");
      const specPath = path.join(projectDir, "spec.yaml");
      res.json({
        ...project,
        analysis: await readJsonIfExists(analysisPath),
        spec: await readTextIfExists(specPath),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/projects/:id", async (req, res, next) => {
    try {
      await args.store.deleteProject(req.params.id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects/:id/start", async (req, res, next) => {
    try {
      await args.orchestrator.start(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects/:id/approve", async (req, res, next) => {
    try {
      await args.orchestrator.approve(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects/:id/reject", async (req, res, next) => {
    try {
      await args.orchestrator.reject(req.params.id, req.body?.feedback);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects/:id/retry", async (req, res, next) => {
    try {
      await args.orchestrator.retry(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects/:id/stop", async (req, res, next) => {
    try {
      await args.orchestrator.stop(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects/:id/improve", async (req, res, next) => {
    try {
      await args.orchestrator.improve(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects/:id/chat", async (req, res, next) => {
    try {
      const project = await args.store.readProject(req.params.id);
      const message = await args.store.appendChat(req.params.id, {
        role: "user",
        phase: project.state.currentPhase === 4 ? 4 : 0,
        content: String(req.body?.message ?? ""),
      });
      await args.orchestrator.onChat(req.params.id);
      res.status(201).json(message);
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:id/chat", async (req, res, next) => {
    try {
      res.json(await args.store.readChat(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:id/reports", async (req, res, next) => {
    try {
      const reportsDir = path.join(args.store.projectDir(req.params.id), "reports");
      res.json(await readDirIfExists(reportsDir));
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:id/analysis", async (req, res, next) => {
    try {
      const analysisDir = path.join(args.store.projectDir(req.params.id), "analysis");
      const entries = await readDirIfExists(analysisDir);
      const payload = await Promise.all(
        entries.map(async (fileName) => ({
          fileName,
          contents: await fs.readFile(path.join(analysisDir, fileName), "utf8"),
        })),
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/settings", async (_req, res, next) => {
    try {
      const config = await loadConfig();
      res.json({ config, detectedMt5: await detectMt5Paths() });
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings", async (req, res, next) => {
    try {
      await saveConfig(req.body);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/settings/test-mt5", async (req, res, next) => {
    try {
      res.json(await validateMt5Paths(req.body?.mt5 ?? (await loadConfig()).mt5));
    } catch (error) {
      next(error);
    }
  });

  router.post("/settings/test-codex", async (req, res, next) => {
    try {
      const command = String(req.body?.command ?? (await loadConfig()).codex.command);
      const result = await runCommand({
        command,
        args: ["--version"],
        timeoutMs: 10000,
      });
      res.json({
        ok: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/system/mode", async (_req, res, next) => {
    try {
      const config = await loadConfig();
      res.json({ mode: config.pipeline.mode });
    } catch (error) {
      next(error);
    }
  });

  router.put("/system/mode", async (req, res, next) => {
    try {
      const config = await loadConfig();
      config.pipeline.mode = req.body?.mode;
      await saveConfig(config);
      res.json({ ok: true, mode: config.pipeline.mode });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
