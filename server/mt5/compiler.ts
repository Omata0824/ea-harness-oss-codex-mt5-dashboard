import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "./process.js";
import type { CompileResult } from "../types.js";

function extractErrorLines(logContents: string): string[] {
  return logContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /:\s*error\b|error\s+\d+/i.test(line));
}

function extractErrorCount(logContents: string, fallbackErrors: string[]): number {
  const summaryLine = logContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^Result:\s*\d+\s+errors?/i.test(line));

  if (!summaryLine) {
    return fallbackErrors.length;
  }

  const match = summaryLine.match(/^Result:\s*(\d+)\s+errors?/i);
  if (!match) {
    return fallbackErrors.length;
  }

  return Number(match[1]);
}

async function ex5ExistsForSource(sourceFile: string): Promise<boolean> {
  const ex5Path = sourceFile.replace(/\.mq5$/i, ".ex5");
  try {
    await fs.access(ex5Path);
    return true;
  } catch {
    return false;
  }
}

export async function compileExpert(args: {
  metaEditorPath: string;
  sourceFile: string;
  logDir: string;
  timeoutMs: number;
}): Promise<CompileResult> {
  await fs.mkdir(args.logDir, { recursive: true });
  const logPath = path.join(args.logDir, `compile-${Date.now()}.log`);
  const result = await runCommand({
    command: args.metaEditorPath,
    args: [`/compile:${args.sourceFile}`, `/log:${logPath}`],
    timeoutMs: args.timeoutMs,
  });

  let logContents = "";
  try {
    logContents = await fs.readFile(logPath, "utf8");
  } catch {
    logContents = "";
  }

  const errors = extractErrorLines(logContents);
  const errorCount = extractErrorCount(logContents, errors);
  const ex5Exists = await ex5ExistsForSource(args.sourceFile);

  return {
    success: errorCount === 0 || ex5Exists,
    logPath,
    errors,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
