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
    case 4:
      return "analysis_complete";
    default:
      return undefined;
  }
}

function wantsPhase3Rerun(message = ""): boolean {
  const normalized = message.toLowerCase().replace(/\s+/g, "");
  if (!normalized) {
    return false;
  }

  const mentionsPhase3 = /(?:phase|フェーズ|第)[3３三]|[3３三](?:phase|フェーズ)/.test(normalized);
  const mentionsOptimization = /最適化|optimization|optimi[sz]e/.test(normalized);
  const requestsRerun = /戻|再|もう一回|やり直|かけ直|かけて|実行|走らせ|run|rerun|redo|again|back/.test(
    normalized,
  );
  const explicitOptimizationRerun =
    /再最適化|もう一回.*最適化|最適化.*(やり直|かけ直|かけて|再実行|実行|走らせ)|rerun.*optimization|optimization.*again/.test(
      normalized,
    );

  return explicitOptimizationRerun || (mentionsOptimization && requestsRerun && mentionsPhase3);
}

function wantsSpecImprovement(message = ""): boolean {
  const normalized = message.toLowerCase().replace(/\s+/g, "");
  if (!normalized || wantsPhase3Rerun(message)) {
    return false;
  }

  return /改善|改良|修正|変更|変え|追加|削除|除外|反映|見直|固定|検証|条件|ロジック|パラメータ|仕様|spec|コード|ea|エントリ|決済/.test(
    normalized,
  );
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

      if (project.state.currentPhase === 4 && wantsPhase3Rerun(feedback)) {
        project.state.currentPhase = 3;
        project.state.status = "running";
        project.state.awaitingApproval = undefined;
        await this.store.writeProject(project);
      } else if (project.state.currentPhase === 4 && wantsSpecImprovement(feedback)) {
        await this.store.createSnapshot(projectId, "before-chat-improve");
        project.state.iteration += 1;
        project.state.currentPhase = 0;
        project.state.status = "running";
        project.state.awaitingApproval = undefined;
        await this.store.writeProject(project);
      }

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

  async improve(projectId: string, feedback?: string): Promise<void> {
    await this.store.createSnapshot(projectId, "before-improve");
    const project = await this.store.readProject(projectId);
    if (feedback?.trim()) {
      await this.store.appendChat(projectId, {
        role: "user",
        phase: project.state.currentPhase === 4 ? 4 : 0,
        content: feedback.trim(),
      });
    }
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

    if (project.state.currentPhase === 4) {
      const messages = await this.store.readChat(projectId);
      const latestUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      if (wantsPhase3Rerun(latestUserMessage)) {
        project.state.currentPhase = 3;
      } else if (wantsSpecImprovement(latestUserMessage)) {
        await this.store.createSnapshot(projectId, "before-chat-improve");
        project.state.iteration += 1;
        project.state.currentPhase = 0;
      }
    }

    project.state.status = "running";
    project.state.awaitingApproval = undefined;
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
