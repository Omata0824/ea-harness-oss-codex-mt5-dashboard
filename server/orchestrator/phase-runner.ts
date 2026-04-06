import { constants, promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveRoot } from "../config.js";
import { callCodex } from "../codex/agent.js";
import { compileExpert } from "../mt5/compiler.js";
import {
  buildIniValues,
  buildTesterInputsSection,
  deployTesterProfile,
  deployExpertToMt5,
  readLatestTesterLog,
  readMq5InputDefaults,
  runTerminal,
  writeOptimizationSetFile,
  writeTesterConfig,
} from "../mt5/tester.js";
import { parseBacktestHtml } from "../parser/backtest-html.js";
import { parseOptimizerXml } from "../parser/optimizer-xml.js";
import { waitForReport } from "../watcher/report-watcher.js";
import type { EnvironmentConfig, PhaseRunOutcome, ProjectRecord } from "../types.js";
import type { StateStore } from "./state.js";

const OPTIMIZATION_MAX_PASSES = 1000;
const OPTIMIZATION_TIMEFRAME = "M1";
const OPTIMIZATION_MODEL = "1";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCompiledExpertPath(projectDir: string, eaName: string): Promise<string> {
  const preferredPath = path.join(projectDir, "src", `${eaName}.ex5`);
  if (await exists(preferredPath)) {
    return preferredPath;
  }

  const srcDir = path.join(projectDir, "src");
  const entries = await fs.readdir(srcDir);
  const candidates = entries
    .filter((name) => name.toLowerCase().endsWith(".ex5"))
    .map((name) => path.join(srcDir, name));

  if (candidates.length > 0) {
    return candidates[0];
  }

  throw new Error(`Compiled expert binary not found in ${srcDir}`);
}

async function writeMt5Config(args: {
  templatePath: string;
  outputPath: string;
  expertPath: string;
  symbol: string;
  timeframe: string;
  reportPath: string;
  config: EnvironmentConfig;
  testerInputs?: string;
  model?: string;
}): Promise<void> {
  const values = buildIniValues({
    expertPath: args.expertPath,
    symbol: args.symbol,
    timeframe: args.timeframe,
    reportPath: args.reportPath,
    environment: args.config,
    testerInputs: args.testerInputs,
    model: args.model,
  });

  await writeTesterConfig({
    templatePath: args.templatePath,
    outputPath: args.outputPath,
    values,
  });

  const rendered = await fs.readFile(args.outputPath, "utf8");
  if (
    !rendered.includes(`Expert=${values.EXPERT_PATH}`) ||
    !rendered.includes(`Symbol=${values.SYMBOL}`) ||
    !rendered.includes(`Period=${values.TIMEFRAME}`)
  ) {
    throw new Error(`Generated tester config does not contain expected values: ${args.outputPath}`);
  }
}

interface OptimizationParam {
  name: string;
  start: number;
  stop: number;
  step: number;
}

function toOptimizationParam(item: Record<string, unknown>): OptimizationParam | null {
  const name = String(item.name ?? "").trim();
  const start = Number(item.start);
  const stop = Number(item.stop);
  const step = Number(item.step);

  if (!name || !Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step) || step <= 0) {
    return null;
  }

  return {
    name,
    start,
    stop,
    step,
  };
}

function estimateOptimizationCount(params: OptimizationParam[]): number {
  return params.reduce((product, item) => {
    const span = Math.max(0, item.stop - item.start);
    const count = Math.max(1, Math.floor(span / item.step) + 1);
    return product * count;
  }, 1);
}

function cloneOptimizationParams(params: OptimizationParam[]): OptimizationParam[] {
  return params.map((item) => ({ ...item }));
}

function toFiniteNumber(value: unknown): number | null {
  const normalized = String(value ?? "")
    .replaceAll(",", "")
    .replaceAll(" ", "")
    .trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortOptimizationRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...rows].sort((left, right) => {
    const leftResult = toFiniteNumber(left.Result);
    const rightResult = toFiniteNumber(right.Result);

    if (leftResult !== null && rightResult !== null && leftResult !== rightResult) {
      return rightResult - leftResult;
    }

    const leftProfit = toFiniteNumber(left.Profit);
    const rightProfit = toFiniteNumber(right.Profit);

    if (leftProfit !== null && rightProfit !== null && leftProfit !== rightProfit) {
      return rightProfit - leftProfit;
    }

    return 0;
  });
}

function summarizeParameter(rowSet: Array<Record<string, unknown>>, key: string) {
  const values = rowSet
    .map((row) => row[key])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  const numericValues = values.map(toFiniteNumber).filter((value): value is number => value !== null);
  const counts = new Map<string, number>();

  values.forEach((value) => {
    const normalized = String(value);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  });

  const mostCommon = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];

  return {
    name: key,
    uniqueValues: counts.size,
    mostCommon: mostCommon ? { value: mostCommon[0], count: mostCommon[1] } : null,
    min: numericValues.length > 0 ? Math.min(...numericValues) : null,
    max: numericValues.length > 0 ? Math.max(...numericValues) : null,
  };
}

function buildFallbackAnalysisReport(args: {
  spec: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  reason: string;
}): Record<string, unknown> {
  const sortedRows = sortOptimizationRows(args.rows);
  const topRows = sortedRows.slice(0, 20);
  const best = topRows[0] ?? {};
  const parameterKeys = Object.keys(best).filter(
    (key) =>
      ![
        "Pass",
        "Result",
        "Profit",
        "Expected Payoff",
        "Profit Factor",
        "Recovery Factor",
        "Sharpe Ratio",
        "Custom",
        "Equity DD %",
        "Trades",
      ].includes(key),
  );
  const parameterSummary = parameterKeys.map((key) => summarizeParameter(topRows, key));
  const tradeCounts = topRows
    .map((row) => toFiniteNumber(row.Trades))
    .filter((value): value is number => value !== null);
  const ddValues = topRows
    .map((row) => toFiniteNumber(row["Equity DD %"]))
    .filter((value): value is number => value !== null);
  const resultValues = topRows
    .map((row) => toFiniteNumber(row.Result))
    .filter((value): value is number => value !== null);
  const bestResult = toFiniteNumber(best.Result);
  const bestProfit = toFiniteNumber(best.Profit);
  const bestTrades = toFiniteNumber(best.Trades);
  const bestDrawdown = toFiniteNumber(best["Equity DD %"]);

  const riskReasons: string[] = [];
  if (bestTrades !== null && bestTrades < 200) {
    riskReasons.push("上位設定の取引数が少なく、統計的な安定性が弱いです。");
  }
  if (bestDrawdown !== null && bestDrawdown > 30) {
    riskReasons.push("上位設定でもドローダウンが大きく、実運用リスクが高いです。");
  }
  if (parameterSummary.some((item) => item.uniqueValues <= 2)) {
    riskReasons.push("上位設定が狭い値に偏っており、境界に張り付いている可能性があります。");
  }
  if (resultValues.length > 1 && Math.abs(resultValues[0] - resultValues[resultValues.length - 1]) < 100) {
    riskReasons.push("上位候補同士の差が小さく、最適化優位性は限定的です。");
  }

  const improvementSuggestions = [
    bestProfit !== null && bestProfit <= 0
      ? "上位候補でも損益がマイナスです。エントリー条件を増やすより、先に損切り・利確・時間切れ決済の見直しを優先してください。"
      : "上位候補の損益はプラスですが、別期間で再検証して再現性を確認してください。",
    bestTrades !== null && bestTrades < 300
      ? "取引数を増やすため、RSI の閾値を緩めるか、取引時間帯フィルターを追加して過剰な見送りを減らしてください。"
      : "取引数は確保できているため、ボラティリティ条件やトレンドフィルターで無駄な逆張りを減らしてください。",
    "M1 OHLC 最適化で候補を絞った後、上位 3 パターンだけをより長い期間と別期間でフォワード確認してください。",
  ];

  return {
    generator: "local-fallback",
    reason: args.reason,
    summary: {
      ea_name: String(args.spec.ea_name ?? ""),
      symbol: String(args.spec.symbol ?? ""),
      timeframe: String(args.spec.timeframe ?? ""),
      tested_rows: args.rows.length,
      reviewed_top_rows: topRows.length,
      best_result: bestResult,
      best_profit: bestProfit,
      best_trades: bestTrades,
      best_equity_dd_percent: bestDrawdown,
    },
    top_parameters: parameterSummary,
    overfitting_risk: {
      level: riskReasons.length >= 2 ? "high" : riskReasons.length === 1 ? "medium" : "low",
      reasons: riskReasons,
    },
    reliability: {
      average_trades:
        tradeCounts.length > 0
          ? Number((tradeCounts.reduce((sum, value) => sum + value, 0) / tradeCounts.length).toFixed(2))
          : null,
      average_equity_dd_percent:
        ddValues.length > 0
          ? Number((ddValues.reduce((sum, value) => sum + value, 0) / ddValues.length).toFixed(2))
          : null,
    },
    improvement_suggestions: improvementSuggestions,
  };
}

function limitOptimizationParams(
  params: Array<Record<string, unknown>>,
  maxPasses: number,
): {
  params: Array<Record<string, number | string>>;
  originalPasses: number;
  limitedPasses: number;
} {
  const normalized = params.map(toOptimizationParam).filter((item): item is OptimizationParam => item !== null);
  if (normalized.length === 0) {
    return { params: [], originalPasses: 0, limitedPasses: 0 };
  }

  const limited = cloneOptimizationParams(normalized);
  const originalPasses = estimateOptimizationCount(limited);
  let limitedPasses = originalPasses;
  let guard = 0;

  while (limitedPasses > maxPasses && guard < 64) {
    const counts = limited.map((item) => {
      const span = Math.max(0, item.stop - item.start);
      return Math.max(1, Math.floor(span / item.step) + 1);
    });
    const targetIndex = counts.reduce((bestIndex, count, index, all) => {
      return count > all[bestIndex] ? index : bestIndex;
    }, 0);
    const target = limited[targetIndex];
    const span = Math.max(0, target.stop - target.start);

    if (span <= 0 || counts[targetIndex] <= 1) {
      break;
    }

    target.step = Math.min(span, Number((target.step * 2).toFixed(10)));
    limitedPasses = estimateOptimizationCount(limited);
    guard += 1;
  }

  return {
    params: limited.map((item) => ({
      name: item.name,
      start: Number(item.start.toFixed(10)),
      stop: Number(item.stop.toFixed(10)),
      step: Number(item.step.toFixed(10)),
    })),
    originalPasses,
    limitedPasses,
  };
}

async function readPrompt(name: "phase0" | "phase1" | "phase4"): Promise<string> {
  return fs.readFile(resolveRoot("server", "codex", "prompts", `${name}.md`), "utf8");
}

async function loadSpec(projectDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(projectDir, "spec.yaml"), "utf8");
  return YAML.parse(raw) as Record<string, unknown>;
}

function stringifyChatHistory(history: Array<{ role: string; content: string }>): string {
  return history.map((item) => `${item.role}: ${item.content}`).join("\n");
}

export async function runPhase(args: {
  project: ProjectRecord;
  config: EnvironmentConfig;
  store: StateStore;
  onProgress: (message: string) => void;
}): Promise<PhaseRunOutcome> {
  const projectDir = args.store.projectDir(args.project.id);

  switch (args.project.state.currentPhase) {
    case 0:
      return runPhase0({ ...args, projectDir });
    case 1:
      return runPhase1({ ...args, projectDir });
    case 2:
      return runPhase2({ ...args, projectDir });
    case 3:
      return runPhase3({ ...args, projectDir });
    case 4:
      return runPhase4({ ...args, projectDir });
    default:
      return { success: false, artifacts: [], error: "Unknown phase" };
  }
}

async function runPhase0(args: {
  project: ProjectRecord;
  config: EnvironmentConfig;
  store: StateStore;
  projectDir: string;
  onProgress: (message: string) => void;
}): Promise<PhaseRunOutcome> {
  const specPath = path.join(args.projectDir, "spec.yaml");
  const prompt = await readPrompt("phase0");
  const history = await args.store.readChat(args.project.id);
  const hadSpecBefore = await exists(specPath);

  const filledPrompt = `${prompt.replace("{idea_text}", args.project.idea)}

## 会話履歴
${stringifyChatHistory(history)}

## 追加ルール
- ユーザーへの返答は必ず日本語にすること
- spec.yaml のキー名は英語のまま、値や説明は日本語にすること
- 既存の spec.yaml がある場合は、会話履歴の修正依頼を反映して更新すること
- 不明点があれば質問だけを返してください
- 仕様が確定しているなら spec.yaml を生成または更新してください`;

  args.onProgress("Codex で仕様書を生成します");
  const result = await callCodex({
    prompt: filledPrompt,
    writableFiles: [specPath],
    readOnlyFiles: [],
    workDir: args.projectDir,
    timeoutMs: args.config.codex.timeout_seconds * 1000,
    command: args.config.codex.command,
    approvalMode: args.config.codex.approval_mode,
  });

  if (await exists(specPath)) {
    const changedSpec = result.changedFiles.includes(specPath) || !hadSpecBefore;
    const infoMessage = changedSpec
      ? "仕様書を更新しました。パイプラインタブで内容を確認し、問題なければ承認してください。"
      : "仕様書を確認してください。問題なければ承認してください。";

    await args.store.appendChat(args.project.id, {
      role: "assistant",
      phase: 0,
      content: infoMessage,
    });

    return { success: true, artifacts: [specPath, ...result.changedFiles] };
  }

  const message = result.stdout.trim() || result.stderr.trim() || "仕様生成で追加の入力が必要です。";
  await args.store.appendChat(args.project.id, {
    role: "assistant",
    phase: 0,
    content: message,
  });

  return {
    success: true,
    artifacts: [],
    waitingForInput: true,
    message,
  };
}

async function runPhase1(args: {
  project: ProjectRecord;
  config: EnvironmentConfig;
  store: StateStore;
  projectDir: string;
  onProgress: (message: string) => void;
}): Promise<PhaseRunOutcome> {
  const spec = await loadSpec(args.projectDir);
  const specPath = path.join(args.projectDir, "spec.yaml");
  const baseTemplatePath = resolveRoot("templates", "ea_base.mq5");
  const prompt = await readPrompt("phase1");
  const eaName = String(spec.ea_name ?? "GeneratedEA");
  const sourcePath = path.join(args.projectDir, "src", `${eaName}.mq5`);

  let lastCompileError = "";
  for (let attempt = 1; attempt <= args.config.pipeline.compile_max_retry; attempt += 1) {
    args.onProgress(`EA コードを生成します (${attempt}/${args.config.pipeline.compile_max_retry})`);
    const attemptPrompt = `${prompt}

## 追加コンテキスト
- spec.yaml path: ${specPath}
- テンプレート path: ${baseTemplatePath}
- 出力先: ${sourcePath}

${lastCompileError ? `## 直前のコンパイルエラー\n${lastCompileError}` : ""}`;

    const result = await callCodex({
      prompt: attemptPrompt,
      writableFiles: [sourcePath],
      readOnlyFiles: [specPath, baseTemplatePath],
      workDir: args.projectDir,
      timeoutMs: args.config.codex.timeout_seconds * 1000,
      command: args.config.codex.command,
      approvalMode: args.config.codex.approval_mode,
    });

    args.onProgress("MetaEditor でコンパイルします");
    const compile = await compileExpert({
      metaEditorPath: args.config.mt5.metaeditor_path,
      sourceFile: sourcePath,
      logDir: path.join(args.projectDir, "build"),
      timeoutMs: args.config.codex.timeout_seconds * 1000,
    });

    if (compile.success) {
      return {
        success: true,
        artifacts: [sourcePath, compile.logPath, ...result.changedFiles],
      };
    }

    lastCompileError = compile.errors.join("\n") || compile.stderr || compile.stdout;
  }

  return {
    success: false,
    artifacts: [],
    error: `Compile retry limit exceeded.\n${lastCompileError}`,
  };
}

async function runPhase2(args: {
  project: ProjectRecord;
  config: EnvironmentConfig;
  store: StateStore;
  projectDir: string;
  onProgress: (message: string) => void;
}): Promise<PhaseRunOutcome> {
  const spec = await loadSpec(args.projectDir);
  const eaName = String(spec.ea_name ?? "GeneratedEA");
  const iniPath = path.join(args.projectDir, "config", "tester.ini");
  const reportPath = path.join(args.projectDir, "reports", `${eaName}-backtest.htm`);
  const mt5ReportRelativePath = path.join("reports", `${args.project.id}-backtest.htm`).replaceAll("/", "\\");
  const mt5ReportPath = path.join(args.config.mt5.data_folder, mt5ReportRelativePath);
  const summaryPath = path.join(args.projectDir, "analysis", "backtest-summary.json");
  const sourceEx5Path = await resolveCompiledExpertPath(args.projectDir, eaName);

  args.onProgress("バックテスト設定を生成します");
  const deployment = await deployExpertToMt5({
    sourceEx5Path,
    environment: args.config,
    deployFileName: `${args.project.id}.ex5`,
  });
  await writeMt5Config({
    templatePath: resolveRoot("templates", "tester.ini.template"),
    outputPath: iniPath,
    expertPath: deployment.expertConfigPath,
    symbol: String(spec.symbol ?? "USDJPY"),
    timeframe: String(spec.timeframe ?? "H1"),
    reportPath: mt5ReportRelativePath,
    config: args.config,
    testerInputs: "",
    model: "0",
  });

  args.onProgress("MT5 バックテストを起動します");
  await fs.mkdir(path.dirname(mt5ReportPath), { recursive: true });
  const waitPromise = waitForReport(mt5ReportPath, 30 * 60 * 1000);
  await runTerminal({
    terminalPath: args.config.mt5.terminal_path,
    configPath: iniPath,
    timeoutMs: 30 * 60 * 1000,
  });

  try {
    await Promise.race([
      waitPromise,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch {
    // Waiter errors are handled below when we inspect the report path.
  }

  if (!(await exists(mt5ReportPath))) {
    const testerLog = await readLatestTesterLog(args.config.mt5.data_folder);
    return {
      success: false,
      artifacts: [iniPath, deployment.deployedPath],
      error: testerLog
        ? `バックテストレポートが生成されませんでした。\n${testerLog.split(/\r?\n/).slice(-20).join("\n")}`
        : "バックテストレポートが生成されませんでした。",
    };
  }

  args.onProgress("バックテストレポートを解析します");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.copyFile(mt5ReportPath, reportPath);
  const summary = await parseBacktestHtml(reportPath);
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  return { success: true, artifacts: [iniPath, deployment.deployedPath, reportPath, summaryPath] };
}

async function runPhase3(args: {
  project: ProjectRecord;
  config: EnvironmentConfig;
  store: StateStore;
  projectDir: string;
  onProgress: (message: string) => void;
}): Promise<PhaseRunOutcome> {
  const spec = await loadSpec(args.projectDir);
  const eaName = String(spec.ea_name ?? "GeneratedEA");
  const iniPath = path.join(args.projectDir, "config", "optimization.ini");
  const setPath = path.join(args.projectDir, "config", "optimization.set");
  const reportPath = path.join(args.projectDir, "reports", `${eaName}-optimization.xml`);
  const mt5ReportRelativePath = path.join("reports", `${args.project.id}-optimization.xml`).replaceAll("/", "\\");
  const mt5ReportPath = path.join(args.config.mt5.data_folder, mt5ReportRelativePath);
  const resultPath = path.join(args.projectDir, "analysis", "optimization_result.json");
  const sourceMq5Path = path.join(args.projectDir, "src", `${eaName}.mq5`);
  const sourceEx5Path = await resolveCompiledExpertPath(args.projectDir, eaName);
  const currentValues = await readMq5InputDefaults(sourceMq5Path);
  const limitedOptimization = limitOptimizationParams(
    Array.isArray(spec.optimization_params)
      ? (spec.optimization_params as Array<Record<string, unknown>>)
      : [],
    OPTIMIZATION_MAX_PASSES,
  );

  args.onProgress("最適化設定を生成します");
  const deployment = await deployExpertToMt5({
    sourceEx5Path,
    environment: args.config,
    deployFileName: `${args.project.id}.ex5`,
  });
  args.onProgress(
    `最適化候補数を ${limitedOptimization.originalPasses.toLocaleString()} から ${limitedOptimization.limitedPasses.toLocaleString()} に制限します`,
  );
  await writeMt5Config({
    templatePath: resolveRoot("templates", "optimization.ini.template"),
    outputPath: iniPath,
    expertPath: deployment.expertConfigPath,
    symbol: String(spec.symbol ?? "USDJPY"),
    timeframe: OPTIMIZATION_TIMEFRAME,
    reportPath: mt5ReportRelativePath,
    config: args.config,
    testerInputs: buildTesterInputsSection(
      limitedOptimization.params,
      currentValues,
    ),
    model: OPTIMIZATION_MODEL,
  });
  await writeOptimizationSetFile({
    outputPath: setPath,
    optimizationParams: limitedOptimization.params,
    currentValues,
  });
  const deployedSetPath = await deployTesterProfile({
    sourcePath: setPath,
    environment: args.config,
    targetFileName: `${args.project.id}.set`,
  });

  args.onProgress("MT5 最適化を起動します");
  await fs.mkdir(path.dirname(mt5ReportPath), { recursive: true });
  const waitPromise = waitForReport(mt5ReportPath, 30 * 60 * 1000);
  await runTerminal({
    terminalPath: args.config.mt5.terminal_path,
    configPath: iniPath,
    timeoutMs: 30 * 60 * 1000,
  });

  try {
    await Promise.race([
      waitPromise,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch {
    // Waiter errors are handled below when we inspect the report path.
  }

  if (!(await exists(mt5ReportPath))) {
    const testerLog = await readLatestTesterLog(args.config.mt5.data_folder);
    return {
      success: false,
      artifacts: [iniPath, setPath, deployedSetPath, deployment.deployedPath],
      error: testerLog
        ? `最適化レポートが生成されませんでした。\n${testerLog.split(/\r?\n/).slice(-20).join("\n")}`
        : "最適化レポートが生成されませんでした。",
    };
  }

  args.onProgress("最適化レポートを解析します");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.copyFile(mt5ReportPath, reportPath);
  const rows = await parseOptimizerXml(reportPath);
  if (rows.length === 0) {
    const testerLog = await readLatestTesterLog(args.config.mt5.data_folder);
    return {
      success: false,
      artifacts: [iniPath, setPath, deployedSetPath, deployment.deployedPath, reportPath],
      error: testerLog
        ? `最適化レポートは生成されましたが、結果行が 0 件です。\n${testerLog.split(/\r?\n/).slice(-20).join("\n")}`
        : "最適化レポートは生成されましたが、結果行が 0 件です。",
    };
  }
  await fs.writeFile(resultPath, JSON.stringify(rows, null, 2), "utf8");

  return { success: true, artifacts: [iniPath, setPath, deployedSetPath, deployment.deployedPath, reportPath, resultPath] };
}

async function runPhase4(args: {
  project: ProjectRecord;
  config: EnvironmentConfig;
  store: StateStore;
  projectDir: string;
  onProgress: (message: string) => void;
}): Promise<PhaseRunOutcome> {
  const specPath = path.join(args.projectDir, "spec.yaml");
  const resultPath = path.join(args.projectDir, "analysis", "optimization_result.json");
  const reportPath = path.join(args.projectDir, "analysis", "report.json");
  const prompt = await readPrompt("phase4");
  const optimizationRaw = await fs.readFile(resultPath, "utf8");
  const optimization = JSON.parse(optimizationRaw) as Array<Record<string, unknown>>;
  const top20 = sortOptimizationRows(optimization).slice(0, 20);
  const top20Path = path.join(args.projectDir, "analysis", "optimization_result.top20.json");
  await fs.writeFile(top20Path, JSON.stringify(top20, null, 2), "utf8");

  args.onProgress("Codex で最適化結果を分析します");
  try {
    const result = await callCodex({
      prompt: `${prompt}

## 補足
- 入力ファイル: ${resultPath}
- 上位20件: ${top20Path}
- 出力先: ${reportPath}`,
      writableFiles: [reportPath],
      readOnlyFiles: [specPath, top20Path],
      workDir: args.projectDir,
      timeoutMs: Math.max(args.config.codex.timeout_seconds * 1000, 10 * 60 * 1000),
      command: args.config.codex.command,
      approvalMode: args.config.codex.approval_mode,
    });

    if (!(await exists(reportPath))) {
      await fs.writeFile(
        reportPath,
        JSON.stringify(
          {
            summary: "Codex did not create analysis/report.json",
            stdout: result.stdout,
            stderr: result.stderr,
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    return { success: true, artifacts: [reportPath, top20Path, ...result.changedFiles] };
  } catch (error) {
    const spec = await loadSpec(args.projectDir);
    const fallbackReport = buildFallbackAnalysisReport({
      spec,
      rows: top20,
      reason: error instanceof Error ? error.message : String(error),
    });
    await fs.writeFile(reportPath, JSON.stringify(fallbackReport, null, 2), "utf8");
    args.onProgress("Codex の分析がタイムアウトしたため、ローカル要約レポートを生成しました");
    return { success: true, artifacts: [reportPath, top20Path] };
  }

  args.onProgress("Codex で最適化結果を分析します");
  const result = await callCodex({
    prompt: `${prompt}

## 補足
- 元ファイル: ${resultPath}
- 上位20件: ${top20Path}
- 出力先: ${reportPath}`,
    writableFiles: [reportPath],
    readOnlyFiles: [specPath, top20Path],
    workDir: args.projectDir,
    timeoutMs: args.config.codex.timeout_seconds * 1000,
    command: args.config.codex.command,
    approvalMode: args.config.codex.approval_mode,
  });

  if (!(await exists(reportPath))) {
    await fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          summary: "Codex did not create analysis/report.json",
          stdout: result.stdout,
          stderr: result.stderr,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return { success: true, artifacts: [reportPath, top20Path, ...result.changedFiles] };
}
