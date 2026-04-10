import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { resolveRoot } from "../config.js";
import type {
  ChatMessage,
  PipelineState,
  ProjectRecord,
  ProjectSnapshot,
  ProjectSnapshotView,
} from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class StateStore {
  readonly workspaceRoot = resolveRoot("workspace");

  async ensureWorkspace(): Promise<void> {
    await fs.mkdir(this.workspaceRoot, { recursive: true });
  }

  projectDir(projectId: string): string {
    return path.join(this.workspaceRoot, projectId);
  }

  projectFile(projectId: string): string {
    return path.join(this.projectDir(projectId), "project.json");
  }

  chatFile(projectId: string): string {
    return path.join(this.projectDir(projectId), "chat.json");
  }

  historyDir(projectId: string): string {
    return path.join(this.projectDir(projectId), "history");
  }

  async createProject(input: { name?: string; idea: string; mode: PipelineState["mode"] }): Promise<ProjectRecord> {
    await this.ensureWorkspace();
    const id = uuidv4();
    const projectPath = this.projectDir(id);
    const timestamp = nowIso();
    await fs.mkdir(projectPath, { recursive: true });
    await Promise.all([
      fs.mkdir(path.join(projectPath, "src"), { recursive: true }),
      fs.mkdir(path.join(projectPath, "build"), { recursive: true }),
      fs.mkdir(path.join(projectPath, "config"), { recursive: true }),
      fs.mkdir(path.join(projectPath, "reports"), { recursive: true }),
      fs.mkdir(path.join(projectPath, "analysis"), { recursive: true }),
    ]);

    const record: ProjectRecord = {
      id,
      name: input.name?.trim() || `project-${id.slice(0, 8)}`,
      idea: input.idea,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: {
        projectId: id,
        currentPhase: 0,
        status: "idle",
        mode: input.mode,
        phaseHistory: [],
        iteration: 0,
        retryCount: 0,
      },
    };

    await Promise.all([
      fs.writeFile(this.projectFile(id), JSON.stringify(record, null, 2), "utf8"),
      fs.writeFile(this.chatFile(id), "[]", "utf8"),
    ]);

    return record;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    await this.ensureWorkspace();
    const entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readProject(entry.name).catch(() => null)),
    );
    return projects.filter((project): project is ProjectRecord => project !== null);
  }

  async readProject(projectId: string): Promise<ProjectRecord> {
    const raw = await fs.readFile(this.projectFile(projectId), "utf8");
    return JSON.parse(raw) as ProjectRecord;
  }

  async recoverInterruptedProjects(): Promise<ProjectRecord[]> {
    const projects = await this.listProjects();
    const recovered: ProjectRecord[] = [];

    for (const project of projects) {
      if (project.state.status !== "running") {
        continue;
      }

      project.state.status = "error";
      project.state.lastError = "サーバー再起動により処理が中断されました。Retry で再開してください。";
      await this.writeProject(project);
      recovered.push(project);
    }

    return recovered;
  }

  async writeProject(project: ProjectRecord): Promise<void> {
    project.updatedAt = nowIso();
    await fs.writeFile(this.projectFile(project.id), JSON.stringify(project, null, 2), "utf8");
  }

  async deleteProject(projectId: string): Promise<void> {
    const projectPath = this.projectDir(projectId);
    if (!(await pathExists(projectPath))) {
      return;
    }
    await fs.rm(projectPath, { recursive: true, force: true });
  }

  async readChat(projectId: string): Promise<ChatMessage[]> {
    const raw = await fs.readFile(this.chatFile(projectId), "utf8");
    return JSON.parse(raw) as ChatMessage[];
  }

  async appendChat(
    projectId: string,
    message: Omit<ChatMessage, "id" | "createdAt">,
  ): Promise<ChatMessage> {
    const messages = await this.readChat(projectId);
    const next: ChatMessage = {
      ...message,
      id: uuidv4(),
      createdAt: nowIso(),
    };
    messages.push(next);
    await fs.writeFile(this.chatFile(projectId), JSON.stringify(messages, null, 2), "utf8");
    return next;
  }

  async listSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
    const historyPath = this.historyDir(projectId);
    if (!(await pathExists(historyPath))) {
      return [];
    }

    const entries = await fs.readdir(historyPath, { withFileTypes: true });
    const snapshots = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const metadataPath = path.join(historyPath, entry.name, "snapshot.json");
          if (!(await pathExists(metadataPath))) {
            return null;
          }

          const raw = await fs.readFile(metadataPath, "utf8");
          return JSON.parse(raw) as ProjectSnapshot;
        }),
    );

    return snapshots
      .filter((snapshot): snapshot is ProjectSnapshot => snapshot !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createSnapshot(projectId: string, reason: string): Promise<ProjectSnapshot> {
    const project = await this.readProject(projectId);
    const createdAt = nowIso();
    const stamp = createdAt.replaceAll(":", "-").replaceAll(".", "-");
    const snapshotId = `${stamp}-${reason}`;
    const snapshotPath = path.join(this.historyDir(projectId), snapshotId);

    await fs.mkdir(snapshotPath, { recursive: true });

    const snapshot: ProjectSnapshot = {
      id: snapshotId,
      createdAt,
      reason,
      iteration: project.state.iteration,
      phase: project.state.currentPhase,
      status: project.state.status,
      path: snapshotPath,
    };

    const targets = [
      "spec.yaml",
      "project.json",
      "chat.json",
      "src",
      "analysis",
      "reports",
      "config",
      "build",
    ];

    for (const target of targets) {
      const sourcePath = path.join(this.projectDir(projectId), target);
      if (!(await pathExists(sourcePath))) {
        continue;
      }

      const destinationPath = path.join(snapshotPath, target);
      await fs.cp(sourcePath, destinationPath, { recursive: true, force: true });
    }

    await fs.writeFile(path.join(snapshotPath, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
    return snapshot;
  }

  async readSnapshot(projectId: string, snapshotId: string): Promise<ProjectSnapshotView> {
    const metadataPath = path.join(this.historyDir(projectId), snapshotId, "snapshot.json");
    const snapshotPath = path.dirname(metadataPath);

    if (!(await pathExists(metadataPath))) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const snapshot = JSON.parse(await fs.readFile(metadataPath, "utf8")) as ProjectSnapshot;
    const project = JSON.parse(
      await fs.readFile(path.join(snapshotPath, "project.json"), "utf8"),
    ) as ProjectRecord;

    const specPath = path.join(snapshotPath, "spec.yaml");
    const spec = (await pathExists(specPath)) ? await fs.readFile(specPath, "utf8") : null;

    const analysisDir = path.join(snapshotPath, "analysis");
    const analysisEntries = (await pathExists(analysisDir))
      ? await Promise.all(
          (await fs.readdir(analysisDir)).map(async (fileName) => ({
            fileName,
            contents: await fs.readFile(path.join(analysisDir, fileName), "utf8"),
          })),
        )
      : [];

    const chatPath = path.join(snapshotPath, "chat.json");
    const messages = (await pathExists(chatPath))
      ? (JSON.parse(await fs.readFile(chatPath, "utf8")) as ChatMessage[])
      : [];

    return {
      snapshot,
      project,
      spec,
      analysisEntries,
      messages,
    };
  }
}
