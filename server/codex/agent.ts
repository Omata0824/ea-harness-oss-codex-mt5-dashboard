import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "../mt5/process.js";
import type { CodexRequest, CodexResult } from "../types.js";

async function snapshotFiles(workDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const stack = [workDir];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        result.set(fullPath, stat.mtimeMs);
      }
    }
  }

  return result;
}

function diffSnapshots(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed = new Set<string>();
  for (const [filePath, mtimeMs] of after.entries()) {
    if (!before.has(filePath) || before.get(filePath) !== mtimeMs) {
      changed.add(filePath);
    }
  }
  return [...changed];
}

function buildPromptEnvelope(req: CodexRequest): string {
  const writable = req.writableFiles.map((file) => `- ${file}`).join("\n") || "- none";
  const readonly = req.readOnlyFiles.map((file) => `- ${file}`).join("\n") || "- none";
  return [
    "Work only within the provided workspace.",
    "Only modify files listed as writable.",
    "Writable files:",
    writable,
    "Read-only files:",
    readonly,
    "Task:",
    req.prompt,
  ].join("\n");
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function isWithinDir(filePath: string, dirPath: string): boolean {
  const target = normalizePath(filePath);
  const base = normalizePath(dirPath);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function collectAdditionalDirs(req: CodexRequest): string[] {
  const candidateFiles = [...req.writableFiles, ...req.readOnlyFiles];
  const dirs = new Set<string>();

  for (const filePath of candidateFiles) {
    const absolute = path.resolve(filePath);
    if (!isWithinDir(absolute, req.workDir)) {
      dirs.add(path.dirname(absolute));
    }
  }

  return [...dirs];
}

function buildExecArgs(req: CodexRequest, outputFile: string): string[] {
  const args = ["exec", "--skip-git-repo-check", "--output-last-message", outputFile];

  if (req.approvalMode === "full-auto") {
    args.push("--full-auto");
  }

  for (const dir of collectAdditionalDirs(req)) {
    args.push("--add-dir", dir);
  }

  args.push(buildPromptEnvelope(req));
  return args;
}

export async function callCodex(req: CodexRequest): Promise<CodexResult> {
  const before = await snapshotFiles(req.workDir);
  const outputFile = path.join(req.workDir, `.codex-last-message-${Date.now()}.txt`);
  const result = await runCommand({
    command: req.command,
    args: buildExecArgs(req, outputFile),
    cwd: req.workDir,
    timeoutMs: req.timeoutMs,
  });
  let lastMessage = "";

  try {
    lastMessage = await fs.readFile(outputFile, "utf8");
    await fs.unlink(outputFile);
  } catch {
    lastMessage = "";
  }
  const after = await snapshotFiles(req.workDir);

  return {
    exitCode: result.exitCode,
    stdout: lastMessage || result.stdout,
    stderr: result.stderr,
    changedFiles: diffSnapshots(before, after),
  };
}
