import { spawn, type ChildProcess } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

interface RunCommandArgs {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  stdinText?: string;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function hasKnownExecutableExtension(value: string): boolean {
  return /\.[a-z0-9]+$/i.test(value);
}

function quoteForCmd(value: string): string {
  if (!value) {
    return '""';
  }

  if (/[\s"&()^%!<>|]/.test(value)) {
    return `"${value.replaceAll('"', '\\"')}"`;
  }

  return value;
}

async function resolveWindowsCommand(command: string): Promise<SpawnTarget> {
  const lower = command.toLowerCase();

  if (hasPathSeparator(command) || hasKnownExecutableExtension(command)) {
    return { command, args: [] };
  }

  const candidates = [
    path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm", `${command}.cmd`),
    path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm", `${command}.ps1`),
    path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm", command),
  ];

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }

    if (candidate.toLowerCase().endsWith(".cmd") || candidate.toLowerCase().endsWith(".bat")) {
      const comspec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
      return { command: comspec, args: ["/d", "/s", "/c", quoteForCmd(candidate)] };
    }

    if (candidate.toLowerCase().endsWith(".ps1")) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate],
      };
    }

    return { command: candidate, args: [] };
  }

  if (lower === "codex") {
    const vscodeFallback = path.join(
      os.homedir(),
      ".vscode",
      "extensions",
      "openai.chatgpt-26.5401.11717-win32-x64",
      "bin",
      "windows-x86_64",
      "codex.exe",
    );
    if (await pathExists(vscodeFallback)) {
      return { command: vscodeFallback, args: [] };
    }
  }

  return { command, args: [] };
}

async function spawnTarget(
  target: SpawnTarget,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  stdinText: string | undefined,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(target.command, [...target.args, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    const killProcess = (processToKill: ChildProcess) => {
      if (processToKill.pid && process.platform === "win32") {
        spawn("taskkill.exe", ["/pid", String(processToKill.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        }).on("error", () => {
          processToKill.kill();
        });
        return;
      }

      processToKill.kill();
    };

    const timer = setTimeout(() => {
      killProcess(proc);
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${target.command}`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });

    if (stdinText !== undefined) {
      proc.stdin.write(stdinText, "utf8");
    }
    proc.stdin.end();
  });
}

export async function runCommand({
  command,
  args,
  cwd,
  timeoutMs,
  stdinText,
}: RunCommandArgs): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const target = process.platform === "win32" ? await resolveWindowsCommand(command) : { command, args: [] };
  return spawnTarget(target, args, cwd, timeoutMs, stdinText);
}
