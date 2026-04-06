import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import type { WebSocketHub } from "../api/websocket.js";
import type { ApprovalPoint, PhaseResult, PipelineMode, ProjectRecord } from "../types.js";
import { runPhase } from "./phase-runner.js";
import { StateStore } from "./state.js";

function nowIso(): string {
  return new Date().toISOString();
}

function approvalPointForPhase(phase: number): ApprovalPoint | undefined {
  switch (phase) {
    case 0:
      return "spec_approved";
    case 3:
      return "optimization_complete";
    case 4:
      return "analysis_complete";
    default:
      return undefined;
  }
}

async function appendRuntimeLog(projectDir: string, error: string): Promise<void> {
  const logPath = path.join(projectDir, "build", "runtime-error.log");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `[${nowIso()}] ${error}\n`, "utf8");
}

export class PipelineOrchestrator {
  private readonly running = new Set<string>();

  constructor(
    private readonly store: StateStore,
    private readonly hub: WebSocketHub,
  ) {}

  async setMode(projectId: string, mode: PipelineMode): Promise<ProjectRecord> {
    const project = await this.store.readProject(projectId);
    project.state.mode = mode;
    await this.store.writeProject(project);
    return project;
  }

  async start(projectId: string): Promise<void> {
    if (this.running.has(projectId)) {
      return;
    }
    this.running.add(projectId);
    void this.run(projectId).finally(() => {
      this.running.delete(projectId);
    });
  }

  async approve(projectId: string): Promise<void> {
    const project = await this.store.readProject(projectId);
    if (project.state.status !== "waiting_approval") {
      return;
    }

    if (project.state.currentPhase === 4) {
      project.state.status = "completed";
      project.state.awaitingApproval = undefined;
      await this.store.writeProject(project);
      this.hub.broadcast("pipeline:completed", { projectId });
      return;
    }

    project.state.currentPhase = (project.state.currentPhase + 1) as 1 | 2 | 3 | 4;
    project.state.status = "running";
    project.state.awaitingApproval = undefined;
    await this.store.writeProject(project);
    await this.start(projectId);
  }

  async reject(projectId: string, feedback?: string): Promise<void> {
    const project = await this.store.readProject(projectId);
    project.state.status = "waiting_input";
    project.state.awaitingApproval = undefined;
    await this.store.writeProject(project);

    if ((project.state.currentPhase === 0 || project.state.currentPhase === 4) && feedback) {
      await this.store.appendChat(projectId, {
        role: "user",
        phase: project.state.currentPhase,
        content: feedback,
      });
      await this.start(projectId);
    }
  }

  async retry(projectId: string): Promise<void> {
    const project = await this.store.readProject(projectId);
    project.state.status = "running";
    project.state.lastError = undefined;
    await this.store.writeProject(project);
    await this.start(projectId);
  }

  async stop(projectId: string): Promise<void> {
    const project = await this.store.readProject(projectId);
    project.state.status = "stopped";
    await this.store.writeProject(project);
  }

  async improve(projectId: string): Promise<void> {
    const project = await this.store.readProject(projectId);
    project.state.iteration += 1;
    project.state.currentPhase = 0;
    project.state.status = "running";
    await this.store.writeProject(project);
    await this.start(projectId);
  }

  async onChat(projectId: string): Promise<void> {
    const project = await this.store.readProject(projectId);
    if (project.state.currentPhase !== 0 && project.state.currentPhase !== 4) {
      return;
    }
    project.state.status = "running";
    await this.store.writeProject(project);
    await this.start(projectId);
  }

  private async run(projectId: string): Promise<void> {
    const config = await loadConfig();

    while (true) {
      let project = await this.store.readProject(projectId);
      if (project.state.status === "stopped") {
        return;
      }

      project.state.status = "running";
      await this.store.writeProject(project);
      this.hub.broadcast("phase:changed", {
        projectId,
        phase: project.state.currentPhase,
        status: project.state.status,
      });

      const startedAt = nowIso();

      try {
        const outcome = await runPhase({
          project,
          config,
          store: this.store,
          onProgress: (message) => {
            this.hub.broadcast("phase:progress", {
              projectId,
              phase: project.state.currentPhase,
              message,
            });
          },
        });

        project = await this.store.readProject(projectId);
        const phaseResult: PhaseResult = {
          phase: project.state.currentPhase,
          startedAt,
          completedAt: nowIso(),
          success: outcome.success,
          artifacts: outcome.artifacts,
          error: outcome.error,
        };
        project.state.phaseHistory.push(phaseResult);
        project.state.retryCount = 0;

        if (!outcome.success) {
          project.state.status = "error";
          project.state.lastError = outcome.error;
          await this.store.writeProject(project);
          this.hub.broadcast("error:occurred", {
            projectId,
            phase: project.state.currentPhase,
            error: outcome.error,
          });
          return;
        }

        if (outcome.waitingForInput) {
          project.state.status = "waiting_input";
          await this.store.writeProject(project);
          this.hub.broadcast("chat:message", {
            projectId,
            phase: project.state.currentPhase,
            message: outcome.message,
          });
          return;
        }

        const confirmPoint = approvalPointForPhase(project.state.currentPhase);
        const requiresApproval =
          confirmPoint !== undefined &&
          project.state.mode === "confirm" &&
          config.pipeline.confirm_points.includes(confirmPoint);

        if (requiresApproval) {
          project.state.status = "waiting_approval";
          project.state.awaitingApproval = confirmPoint;
          await this.store.writeProject(project);
          this.hub.broadcast("approval:required", {
            projectId,
            phase: project.state.currentPhase,
            approvalPoint: confirmPoint,
          });
          return;
        }

        if (project.state.currentPhase === 4) {
          project.state.status = "completed";
          await this.store.writeProject(project);
          this.hub.broadcast("pipeline:completed", { projectId });
          return;
        }

        project.state.currentPhase = (project.state.currentPhase + 1) as 1 | 2 | 3 | 4;
        await this.store.writeProject(project);
      } catch (error) {
        project = await this.store.readProject(projectId);
        project.state.status = "error";
        project.state.lastError = error instanceof Error ? error.message : String(error);
        await this.store.writeProject(project);
        this.hub.broadcast("error:occurred", {
          projectId,
          phase: project.state.currentPhase,
          error: project.state.lastError,
        });
        await appendRuntimeLog(this.store.projectDir(projectId), project.state.lastError);
        return;
      }
    }
  }
}
