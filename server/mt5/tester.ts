import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "./process.js";
import type { EnvironmentConfig, TerminalRunResult } from "../types.js";

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((output, [key, value]) => {
    return output.replaceAll(`{{${key}}}`, value);
  }, template);
}

export async function writeTesterConfig(args: {
  templatePath: string;
  outputPath: string;
  values: Record<string, string>;
}): Promise<void> {
  const template = await fs.readFile(args.templatePath, "utf8");
  const rendered = renderTemplate(template, args.values);
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, rendered, "utf8");
}

export async function writeOptimizationSetFile(args: {
  outputPath: string;
  optimizationParams: Array<Record<string, unknown>>;
  currentValues?: Record<string, string>;
  optimize?: boolean;
}): Promise<void> {
  const lines = args.optimizationParams.flatMap((item) => {
    const name = String(item.name ?? "");
    const start = String(item.start ?? "");
    const step = String(item.step ?? "");
    const stop = String(item.stop ?? "");
    if (!name) {
      return [];
    }
    const current = args.currentValues?.[name] ?? start;
    return [`${name}=${current}||${start}||${step}||${stop}||${args.optimize === false ? "N" : "Y"}`];
  });

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, lines.join("\n"), "utf8");
}

export async function runTerminal(args: {
  terminalPath: string;
  configPath: string;
  timeoutMs: number;
}): Promise<TerminalRunResult> {
  return runCommand({
    command: args.terminalPath,
    args: [`/config:${args.configPath}`],
    timeoutMs: args.timeoutMs,
  });
}

export async function deployExpertToMt5(args: {
  sourceEx5Path: string;
  environment: EnvironmentConfig;
  deployFileName: string;
}): Promise<{ deployedPath: string; expertConfigPath: string; expertAbsolutePath: string }> {
  const targetDir = path.join(args.environment.mt5.data_folder, args.environment.mt5.experts_subfolder);
  const deployedPath = path.join(targetDir, args.deployFileName);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(args.sourceEx5Path, deployedPath);

  const expertsRoot = path.join(args.environment.mt5.data_folder, "MQL5", "Experts");
  const relativeDir = path.relative(expertsRoot, targetDir);
  const expertConfigPath = relativeDir ? `${relativeDir}\\${args.deployFileName}` : args.deployFileName;

  return {
    deployedPath,
    expertConfigPath,
    expertAbsolutePath: deployedPath,
  };
}

export async function deployTesterProfile(args: {
  sourcePath: string;
  environment: EnvironmentConfig;
  targetFileName: string;
}): Promise<string> {
  const targetDir = path.join(args.environment.mt5.data_folder, args.environment.mt5.tester_subfolder);
  const targetPath = path.join(targetDir, args.targetFileName);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(args.sourcePath, targetPath);
  return targetPath;
}

export async function readLatestTesterLog(dataFolder: string): Promise<string> {
  const testerLogDir = path.join(dataFolder, "Tester", "logs");
  let entries;

  try {
    entries = await fs.readdir(testerLogDir);
  } catch {
    return "";
  }

  const candidates = await Promise.all(
    entries
      .filter((name) => name.toLowerCase().endsWith(".log"))
      .map(async (name) => {
        const fullPath = path.join(testerLogDir, name);
        const stat = await fs.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      }),
  );

  const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) {
    return "";
  }

  try {
    const buffer = await fs.readFile(latest.fullPath);
    const isUtf16Le = buffer.length >= 2 && (buffer[0] === 0xff && buffer[1] === 0xfe);
    return buffer.toString(isUtf16Le ? "utf16le" : "utf8");
  } catch {
    return "";
  }
}

export async function readTextWithEncoding(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const isUtf16Le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  return buffer.toString(isUtf16Le ? "utf16le" : "utf8");
}

export function normalizeSymbol(rawSymbol: string): string {
  const parenMatch = rawSymbol.match(/\(([A-Z0-9._-]{6,})\)/);
  if (parenMatch) {
    return parenMatch[1];
  }

  const inlineMatch = rawSymbol.match(/\b([A-Z]{6,})\b/);
  if (inlineMatch) {
    return inlineMatch[1];
  }

  return rawSymbol.replace(/[^\w.-]/g, "").toUpperCase();
}

export function normalizeTimeframe(rawTimeframe: string): string {
  const parenMatch = rawTimeframe.match(/\b(MN1|W1|D1|H4|H1|M30|M15|M5|M1)\b/i);
  if (parenMatch) {
    return parenMatch[1].toUpperCase();
  }

  const normalized = rawTimeframe.replace(/\s+/g, "");
  const map: Record<string, string> = {
    "1分足": "M1",
    "5分足": "M5",
    "15分足": "M15",
    "30分足": "M30",
    "1時間足": "H1",
    "4時間足": "H4",
    "日足": "D1",
    "週足": "W1",
    "月足": "MN1",
  };

  return map[normalized] ?? normalized.toUpperCase();
}

export function buildIniValues(args: {
  expertPath: string;
  symbol: string;
  timeframe: string;
  reportPath: string;
  environment: EnvironmentConfig;
  fromDate?: string;
  toDate?: string;
  testerInputs?: string;
  model?: string;
}): Record<string, string> {
  return {
    EXPERT_PATH: args.expertPath,
    SYMBOL: normalizeSymbol(args.symbol),
    TIMEFRAME: normalizeTimeframe(args.timeframe),
    MODEL: args.model ?? "0",
    FROM_DATE: args.fromDate ?? "2024.01.01",
    TO_DATE: args.toDate ?? "2025.12.31",
    REPORT_PATH: args.reportPath,
    TESTER_INPUTS: args.testerInputs ?? "",
  };
}

export function buildTesterInputsSection(
  optimizationParams: Array<Record<string, unknown>>,
  currentValues: Record<string, string> = {},
  options: { optimize?: boolean } = {},
): string {
  const lines = optimizationParams.flatMap((item) => {
    const name = String(item.name ?? "").trim();
    const start = String(item.start ?? "").trim();
    const step = String(item.step ?? "").trim();
    const stop = String(item.stop ?? "").trim();

    if (!name || !start || !step || !stop) {
      return [];
    }

    const current = currentValues[name] ?? start;
    return [`${name}=${current}||${start}||${step}||${stop}||${options.optimize === false ? "N" : "Y"}`];
  });

  if (lines.length === 0) {
    return "";
  }

  return `\n[TesterInputs]\n${lines.join("\n")}\n`;
}

export async function readMq5InputDefaults(sourcePath: string): Promise<Record<string, string>> {
  const source = await readTextWithEncoding(sourcePath);
  const defaults: Record<string, string> = {};

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*input\s+\w+\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/);
    if (!match) {
      continue;
    }

    defaults[match[1]] = match[2].trim().replace(/^"(.*)"$/, "$1");
  }

  return defaults;
}
