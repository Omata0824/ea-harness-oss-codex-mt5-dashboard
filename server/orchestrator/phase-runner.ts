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

async function removeIfExists(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

async function removeArtifacts(filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map((filePath) => removeIfExists(filePath)));
}

async function hasUsableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function isFileAtLeastAsNewAs(filePath: string, referencePath: string): Promise<boolean> {
  try {
    const [fileStat, referenceStat] = await Promise.all([fs.stat(filePath), fs.stat(referencePath)]);
    return fileStat.isFile() && fileStat.size > 0 && fileStat.mtimeMs >= referenceStat.mtimeMs;
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

interface OptimizationPlan {
  params: Array<Record<string, number | string>>;
  originalPasses: number;
  limitedPasses: number;
  mode: "optimization" | "fixed_validation";
  fixedValues: Record<string, number>;
}

function toOptimizationParam(item: Record<string, unknown>): OptimizationParam | null {
  const name = String(item.name ?? "").trim();
  const start = Number(item.start ?? item.min);
  const stop = Number(item.stop ?? item.max);
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

function readOptimizationParams(spec: Record<string, unknown>): Array<Record<string, unknown>> {
  const rawParams = spec.optimization_params;
  if (Array.isArray(rawParams)) {
    return rawParams as Array<Record<string, unknown>>;
  }

  if (!rawParams || typeof rawParams !== "object") {
    return [];
  }

  return Object.entries(rawParams as Record<string, unknown>).flatMap(([name, value]) => {
    if (!value || typeof value !== "object") {
      return [];
    }

    return [
      {
        name,
        ...(value as Record<string, unknown>),
      },
    ];
  });
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
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFixedValidationValues(spec: Record<string, unknown>): Record<string, number> {
  const rawParams = spec.optimization_params;
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return {};
  }

  const params = rawParams as Record<string, unknown>;
  const fixedValues: Record<string, number> = {};
  const addFixedValue = (name: string, value: unknown) => {
    const parsed = toFiniteNumber(value);
    if (name && parsed !== null) {
      fixedValues[name] = parsed;
    }
  };

  const candidate = params.fixed_validation_candidate;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    for (const [name, value] of Object.entries(candidate as Record<string, unknown>)) {
      addFixedValue(name, value);
    }
  }

  for (const [name, value] of Object.entries(params)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    addFixedValue(name, (value as Record<string, unknown>).fixed_for_validation);
  }

  return fixedValues;
}

function wantsFixedValidation(message = ""): boolean {
  const normalized = message.toLowerCase().replace(/\s+/g, "");
  if (!normalized) {
    return false;
  }

  const rejectsFixedValidation =
    /固定候補.*(?:ではなく|じゃなく|しない|不要)|固定検証.*(?:ではなく|じゃなく|しない|不要)|1点検証.*(?:ではなく|じゃなく|しない|不要)|一点検証.*(?:ではなく|じゃなく|しない|不要)|notfixed|notfixedvalidation/.test(
      normalized,
    );
  if (rejectsFixedValidation) {
    return false;
  }

  const explicitlyOptimization =
    /通常最適化|再最適化|最適化|全範囲|全通り|複数候補|グリッド|optimization/.test(normalized) &&
    !/固定候補|固定検証|1点検証|一点検証|fixedvalidation|fixed_validation/.test(normalized);
  if (explicitlyOptimization) {
    return false;
  }

  return /固定候補|固定検証|固定して検証|1点検証|一点検証|候補だけ|fixedvalidation|fixed_validation/.test(
    normalized,
  );
}

function buildOptimizationPlan(
  spec: Record<string, unknown>,
  maxPasses: number,
  options: { fixedValidation?: boolean } = {},
): OptimizationPlan {
  const rawParams = readOptimizationParams(spec);
  const normalized = rawParams.map(toOptimizationParam).filter((item): item is OptimizationParam => item !== null);
  const fixedValues = readFixedValidationValues(spec);
  const hasCompleteFixedValidation =
    normalized.length > 0 && normalized.every((item) => fixedValues[item.name] !== undefined);

  if (options.fixedValidation === true && hasCompleteFixedValidation) {
    return {
      params: normalized.map((item) => {
        const fixedValue = fixedValues[item.name];
        return {
          name: item.name,
          start: fixedValue,
          stop: fixedValue,
          step: item.step,
        };
      }),
      originalPasses: estimateOptimizationCount(normalized),
      limitedPasses: 1,
      mode: "fixed_validation",
      fixedValues,
    };
  }

  return {
    ...limitOptimizationParams(rawParams, maxPasses),
    mode: "optimization",
    fixedValues,
  };
}

function fixedValuesAsCurrentInputs(fixedValues: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(fixedValues).map(([key, value]) => [key, String(value)]));
}

function firstNumberFromText(value: unknown): number | null {
  const match = String(value ?? "").match(/-?[\d\s,]+(?:\.\d+)?/);
  return match ? toFiniteNumber(match[0]) : null;
}

function percentNumberFromText(value: unknown): number | null {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?\s*%/);
  if (!match) {
    return firstNumberFromText(value);
  }

  return toFiniteNumber(match[0].replace("%", ""));
}

function summaryValue(summary: Record<string, string>, labels: string[]): string {
  for (const label of labels) {
    const value = summary[label];
    if (value !== undefined && value !== "") {
      return value;
    }
  }

  return "";
}

function metricText(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) {
    return "";
  }

  return String(roundNumber(value, digits));
}

function buildFixedValidationRows(
  summary: Record<string, string>,
  fixedValues: Record<string, number>,
): Array<Record<string, string>> {
  const deposit = firstNumberFromText(summaryValue(summary, ["初期証拠金", "initial deposit"])) ?? 10000;
  const profit = firstNumberFromText(summaryValue(summary, ["総損益", "total net profit", "net profit"]));
  const profitFactor = firstNumberFromText(summaryValue(summary, ["プロフィットファクター", "profit factor"]));
  const expectedPayoff = firstNumberFromText(summaryValue(summary, ["期待利得", "expected payoff"]));
  const recoveryFactor = firstNumberFromText(summaryValue(summary, ["リカバリファクター", "recovery factor"]));
  const sharpeRatio = firstNumberFromText(summaryValue(summary, ["シャープレシオ", "sharpe ratio"]));
  const custom = firstNumberFromText(summaryValue(summary, ["ontester 結果", "custom"]));
  const equityDrawdown = percentNumberFromText(
    summaryValue(summary, ["証拠金相対ドローダウン", "残高相対ドローダウン", "equity drawdown relative"]),
  );
  const trades = firstNumberFromText(summaryValue(summary, ["取引数", "total trades", "trades"]));

  return [
    {
      Pass: "fixed_validation",
      Result: metricText(profit === null ? null : deposit + profit, 2),
      Profit: metricText(profit, 2),
      "Expected Payoff": metricText(expectedPayoff, 6),
      "Profit Factor": metricText(profitFactor, 6),
      "Recovery Factor": metricText(recoveryFactor, 6),
      "Sharpe Ratio": metricText(sharpeRatio, 6),
      Custom: metricText(custom, 6),
      "Equity DD %": metricText(equityDrawdown, 4),
      Trades: metricText(trades, 0),
      ...Object.fromEntries(Object.entries(fixedValues).map(([key, value]) => [key, String(value)])),
    },
  ];
}

function hasNonZeroOptimizationTrades(rows: Array<Record<string, unknown>>): boolean {
  return rows.some((row) => {
    const trades = toFiniteNumber(row.Trades);
    return trades !== null && trades > 0;
  });
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

const OPTIMIZATION_METRIC_KEYS = new Set([
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
]);

function roundNumber(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function compactText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(compactText).filter(Boolean).join(", ");
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${compactText(item)}`)
      .join(", ");
  }

  return String(value ?? "").trim();
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function metricValues(rows: Array<Record<string, unknown>>, key: string): number[] {
  return rows.map((row) => toFiniteNumber(row[key])).filter((value): value is number => value !== null);
}

function minValue(values: number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

function maxValue(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function summarizeOptimizationSet(rows: Array<Record<string, unknown>>) {
  const profits = metricValues(rows, "Profit");
  const profitFactors = metricValues(rows, "Profit Factor");
  const drawdowns = metricValues(rows, "Equity DD %");
  const trades = metricValues(rows, "Trades");
  const expectedPayoffs = metricValues(rows, "Expected Payoff");
  const profitableRuns = profits.filter((profit) => profit > 0).length;

  return {
    count: rows.length,
    profitable_runs: profitableRuns,
    profitable_rate_percent: rows.length > 0 ? roundNumber((profitableRuns / rows.length) * 100, 1) : null,
    best_profit: roundNumber(maxValue(profits), 2),
    worst_profit: roundNumber(minValue(profits), 2),
    average_profit: roundNumber(average(profits), 2),
    median_profit: roundNumber(median(profits), 2),
    best_profit_factor: roundNumber(maxValue(profitFactors), 6),
    average_profit_factor: roundNumber(average(profitFactors), 6),
    average_expected_payoff: roundNumber(average(expectedPayoffs), 6),
    min_equity_dd_pct: roundNumber(minValue(drawdowns), 4),
    max_equity_dd_pct: roundNumber(maxValue(drawdowns), 4),
    average_equity_dd_pct: roundNumber(average(drawdowns), 4),
    min_trades: roundNumber(minValue(trades), 0),
    max_trades: roundNumber(maxValue(trades), 0),
    average_trades: roundNumber(average(trades), 1),
  };
}

function compareValueLabels(left: string, right: string): number {
  const leftNumber = toFiniteNumber(left);
  const rightNumber = toFiniteNumber(right);

  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right);
}

function distributionFor(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const rawValue = row[key];
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
      continue;
    }

    const value = String(rawValue);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => compareValueLabels(left, right)));
}

function parameterKeysFor(rows: Array<Record<string, unknown>>, spec: Record<string, unknown>): string[] {
  const keys = new Set<string>();

  for (const item of readOptimizationParams(spec)) {
    const param = toOptimizationParam(item);
    if (param && param.name !== "optimization_timeframe") {
      keys.add(param.name);
    }
  }

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!OPTIMIZATION_METRIC_KEYS.has(key)) {
        keys.add(key);
      }
    }
  }

  return [...keys];
}

function groupRowsByParameter(rows: Array<Record<string, unknown>>, key: string): Array<{
  value: string;
  rows: Array<Record<string, unknown>>;
}> {
  const groups = new Map<string, Array<Record<string, unknown>>>();

  for (const row of rows) {
    const rawValue = row[key];
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
      continue;
    }

    const value = String(rawValue);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }

  return [...groups.entries()]
    .map(([value, groupRows]) => ({ value, rows: groupRows }))
    .sort((left, right) => compareValueLabels(left.value, right.value));
}

function buildParameterTrend(
  rows: Array<Record<string, unknown>>,
  topRows: Array<Record<string, unknown>>,
  key: string,
) {
  const groups = groupRowsByParameter(rows, key);
  const groupStats = groups.map((group) => {
    const summary = summarizeOptimizationSet(group.rows);
    return {
      value: group.value,
      runs: summary.count,
      profitable_runs: summary.profitable_runs,
      average_profit: summary.average_profit,
      best_profit: summary.best_profit,
      average_profit_factor: summary.average_profit_factor,
      average_trades: summary.average_trades,
    };
  });
  const distribution = distributionFor(topRows, key);
  const mostCommonTop = Object.entries(distribution).sort((left, right) => right[1] - left[1])[0] ?? null;
  const bestAverage = [...groupStats].sort((left, right) => {
    return (right.average_profit ?? Number.NEGATIVE_INFINITY) - (left.average_profit ?? Number.NEGATIVE_INFINITY);
  })[0];
  const bestProfit = [...groupStats].sort((left, right) => {
    return (right.best_profit ?? Number.NEGATIVE_INFINITY) - (left.best_profit ?? Number.NEGATIVE_INFINITY);
  })[0];

  const interpretationParts = [
    mostCommonTop
      ? `上位${topRows.length}件では ${key}=${mostCommonTop[0]} が最多です。`
      : `上位${topRows.length}件では ${key} の値を確認できません。`,
    bestAverage
      ? `全候補の平均損益では ${key}=${bestAverage.value} が最も良く、平均Profitは ${bestAverage.average_profit} です。`
      : "",
    bestProfit
      ? `単独の最大Profitは ${key}=${bestProfit.value} のグループから出ています。`
      : "",
  ].filter(Boolean);

  return {
    parameter: key,
    distribution_in_top20: distribution,
    group_view: Object.fromEntries(groupStats.map((item) => [item.value, item])),
    interpretation: interpretationParts.join(" "),
  };
}

function paramsFromRow(row: Record<string, unknown>, parameterKeys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    parameterKeys
      .filter((key) => row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "")
      .map((key) => [key, row[key]]),
  );
}

function buildSpecConsistencyIssues(
  spec: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const params = readOptimizationParams(spec)
    .map(toOptimizationParam)
    .filter((item): item is OptimizationParam => item !== null);
  const issues: Array<Record<string, unknown>> = [];

  for (const param of params) {
    const observedValues = [
      ...new Set(
        rows
          .map((row) => toFiniteNumber(row[param.name]))
          .filter((value): value is number => value !== null),
      ),
    ].sort((left, right) => left - right);
    const outOfRange = observedValues.filter((value) => value < param.start || value > param.stop);

    if (outOfRange.length === 0) {
      continue;
    }

    issues.push({
      parameter: param.name,
      spec_range: `${param.start}-${param.stop}`,
      observed_values_in_results: observedValues,
      out_of_range_values: outOfRange,
      problem: `${param.name} に spec.yaml の範囲外の値が含まれています。`,
    });
  }

  return issues;
}

function buildStableAnalysisReport(args: {
  spec: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const sortedRows = sortOptimizationRows(args.rows);
  const topRows = sortedRows.slice(0, 20);
  const best = topRows[0] ?? {};
  const parameterKeys = parameterKeysFor(sortedRows, args.spec);
  const allSummary = summarizeOptimizationSet(sortedRows);
  const topSummary = summarizeOptimizationSet(topRows);
  const bestProfit = toFiniteNumber(best.Profit);
  const bestProfitFactor = toFiniteNumber(best["Profit Factor"]);
  const bestTrades = toFiniteNumber(best.Trades);
  const bestDrawdown = toFiniteNumber(best["Equity DD %"]);
  const parameterTrends = parameterKeys.map((key) => buildParameterTrend(sortedRows, topRows, key));
  const bestParams = paramsFromRow(best, parameterKeys);
  const consistencyIssues = buildSpecConsistencyIssues(args.spec, sortedRows);
  const positiveRows = sortedRows.filter((row) => (toFiniteNumber(row.Profit) ?? Number.NEGATIVE_INFINITY) > 0);
  const topAverageProfit = topSummary.average_profit;
  const allAverageProfit = allSummary.average_profit;
  const fixedValidationValues = readFixedValidationValues(args.spec);
  const fixedValidationKeys = Object.keys(fixedValidationValues);
  const fixedValidationMatched =
    fixedValidationKeys.length > 0 &&
    fixedValidationKeys.every((key) => toFiniteNumber(best[key]) === fixedValidationValues[key]);
  const analysisMode = fixedValidationKeys.length > 0 && sortedRows.length <= 1 ? "fixed_validation" : "optimization";

  const riskScore =
    (bestProfit === null || bestProfit <= 0 ? 2 : 0) +
    (bestProfitFactor === null || bestProfitFactor < 1.15 ? 1 : 0) +
    (bestTrades === null || bestTrades < 100 ? 1 : 0) +
    ((topSummary.profitable_rate_percent ?? 0) < 30 ? 1 : 0) +
    ((allSummary.profitable_rate_percent ?? 0) < 30 ? 1 : 0) +
    (consistencyIssues.length > 0 ? 1 : 0);
  const riskLevel = riskScore >= 5 ? "高い" : riskScore >= 3 ? "中" : "低い";
  const reliabilityAssessment =
    bestProfit !== null &&
    bestProfit > 0 &&
    bestProfitFactor !== null &&
    bestProfitFactor >= 1.2 &&
    bestTrades !== null &&
    bestTrades >= 100 &&
    (topSummary.profitable_rate_percent ?? 0) >= 40
      ? "中"
      : "低い";

  const conclusion =
    bestProfit === null
      ? "最適化結果を読み取れませんでした。XML解析と最適化設定を確認してください。"
      : bestProfit <= 0
        ? `上位候補でも利益が出ていません。最良候補のProfitは ${roundNumber(bestProfit, 2)} で、パラメータ調整より先にロジック改善が必要です。`
        : bestProfitFactor !== null && bestProfitFactor < 1.15
          ? `利益候補はありますが、最良候補のProfit Factorは ${roundNumber(bestProfitFactor, 3)} と薄く、実運用候補ではなく再検証用の暫定候補です。`
          : `利益候補はあります。最良候補を採用候補にする前に、別期間・別通貨・コスト悪化条件で再確認してください。`;

  const observations = [
    `全${allSummary.count}件中、利益がプラスだった候補は${allSummary.profitable_runs}件です。`,
    `上位${topSummary.count}件の平均Profitは ${topSummary.average_profit}、全体平均Profitは ${allSummary.average_profit} です。`,
    `最良候補の取引回数は ${bestTrades ?? "-"} 件、Profit Factor は ${bestProfitFactor ?? "-"}、Equity DD % は ${bestDrawdown ?? "-"} です。`,
    positiveRows.length > 0
      ? `プラス候補は ${positiveRows.length} 件ありますが、上位候補への集中度と近傍パラメータの再現性を確認する必要があります。`
      : "プラス候補がないため、現状の探索範囲では優位性を確認できません。",
    consistencyIssues.length > 0
      ? "spec.yaml の最適化範囲と実際の結果に不整合があります。次の再実行前に修正してください。"
      : "spec.yaml の最適化範囲と結果値に明確な範囲外不整合は見つかりません。",
  ];

  const riskDetails = [
    bestProfitFactor === null || bestProfitFactor < 1.15
      ? "Profit Factor が低く、手数料・スリッページ・約定差で優位性が消えやすい状態です。"
      : "Profit Factor は最低限の水準を超えていますが、別期間で維持できるかは未確認です。",
    bestTrades === null || bestTrades < 100
      ? "最良候補の取引回数が少なく、少数トレードの偶然に引っ張られている可能性があります。"
      : "最良候補の取引回数は最低限ありますが、月別や年別の偏り確認が必要です。",
    (topAverageProfit ?? 0) <= 0
      ? "上位候補の平均Profitがマイナスで、良い候補が局所的にしか出ていません。"
      : "上位候補の平均Profitはプラスですが、近傍候補も同じ方向で強いか確認してください。",
    (allAverageProfit ?? 0) <= 0
      ? "全体平均Profitがマイナスで、探索範囲の多くは機能していません。"
      : "全体平均Profitはプラスですが、過剰最適化を避けるため探索範囲を分割して確認してください。",
    consistencyIssues.length > 0
      ? "仕様と結果の範囲不整合があるため、現時点の最良値をそのまま信頼するのは危険です。"
      : "仕様範囲の不整合は見つかっていませんが、境界値に寄っている場合は範囲外の近傍確認が必要です。",
  ];

  const reliabilityDetails = [
    `最良候補の取引回数は ${bestTrades ?? "-"} 件です。100件未満なら統計的な信頼性は低く見ます。`,
    `上位${topSummary.count}件のプラス率は ${topSummary.profitable_rate_percent ?? "-"}% です。上位だけでもプラス率が低い場合は、局所最適の疑いが強いです。`,
    `全候補のプラス率は ${allSummary.profitable_rate_percent ?? "-"}% です。探索範囲全体で優位性が広がっているかを確認してください。`,
    "このレポートはインサンプル最適化結果だけを見ています。アウトオブサンプル、ウォークフォワード、コスト悪化テストは未確認です。",
  ];

  const proposals = [
    {
      priority: 1,
      title: "上位候補を別期間で検証する",
      action: `まず最良候補 ${JSON.stringify(bestParams)} を固定し、別期間・別通貨・スプレッド悪化条件でバックテストしてください。`,
      reason: "最適化内で良い値が出ても、別期間で崩れるなら採用できません。",
    },
    {
      priority: 2,
      title: bestProfit !== null && bestProfit > 0 ? "上位パラメータ周辺を狭く再探索する" : "入口ロジックを改善してから再最適化する",
      action:
        bestProfit !== null && bestProfit > 0
          ? "上位候補の周辺だけを狭い範囲で再探索し、近傍でも同じ方向に利益が残るか確認してください。"
          : "パラメータ範囲を広げる前に、エントリー条件・フィルター・決済条件を見直してください。",
      reason: "単発の最良値ではなく、近傍でも強い領域があるかを見るためです。",
    },
    {
      priority: 3,
      title: "取引回数と月別偏りを確認する",
      action: "最良候補と比較候補について、月別損益・年別損益・ロング/ショート別損益を分解してください。",
      reason: "少数の勝ちトレードや特定期間だけの利益で最適化結果が良く見えることがあります。",
    },
    {
      priority: 4,
      title: "損益の悪化耐性を確認する",
      action: "スプレッド、スリッページ、約定遅延を悪化させてもProfit Factorと期待値が残るか確認してください。",
      reason: "Profit Factor が薄い候補は、現実的なコストを入れるとすぐ崩れます。",
    },
    {
      priority: 5,
      title: "不整合があれば仕様と最適化設定をそろえる",
      action:
        consistencyIssues.length > 0
          ? "spec.yaml の start/stop/step と optimization.set の範囲を一致させてから再実行してください。"
          : "次回も spec.yaml と optimization.set の範囲が一致しているか確認してください。",
      reason: "仕様外の値が混じると、改善判断と次の仕様書作成がずれます。",
    },
  ];

  return {
    meta: {
      schema_version: 1,
      generator: "stable-local-analysis",
      analysis_date: new Date().toISOString().slice(0, 10),
      input_files: ["spec.yaml", "analysis/optimization_result.json", "analysis/optimization_result.top20.json"],
      analyzed_cases: topRows.length,
      analyzed_runs: sortedRows.length,
      top_runs_used_for_pattern_review: topRows.length,
      analysis_mode: analysisMode,
      ea_name: compactText(args.spec.ea_name),
      symbol: compactText(args.spec.symbol),
      timeframe: compactText(args.spec.timeframe),
      search_space_size: sortedRows.length,
      scope_note: "最適化結果の全件と上位20件を使い、固定スキーマで統計・リスク・次アクションを整理しています。",
    },
    validation_context: {
      mode: analysisMode,
      fixed_validation_candidate: fixedValidationValues,
      fixed_candidate_matched_result: fixedValidationMatched,
      note:
        analysisMode === "fixed_validation"
          ? "仕様書の fixed_validation_candidate を使った1点検証として分析しています。"
          : "最適化範囲の複数候補を比較する分析です。",
    },
    overall_assessment: {
      conclusion,
      top20_summary: topSummary,
      all_runs_summary: allSummary,
      important_observations: observations,
    },
    common_parameter_trends: {
      summary: parameterTrends
        .map((item) => `${item.parameter}: ${item.interpretation}`)
        .join(" "),
      details: parameterTrends,
      best_configuration: {
        profit: roundNumber(bestProfit, 2),
        profit_factor: roundNumber(bestProfitFactor, 6),
        equity_dd_pct: roundNumber(bestDrawdown, 4),
        trades: roundNumber(bestTrades, 0),
        params: bestParams,
        comment: "最良候補は採用値ではなく、次の検証で中心に置く候補として扱ってください。",
      },
    },
    overfitting_risk: {
      risk_level: riskLevel,
      details: riskDetails,
      specific_examples: parameterTrends
        .slice(0, 3)
        .map((item) => `${item.parameter}: ${item.interpretation}`),
      fragile_points: [
        "最良値だけでなく、その前後の値でも利益が残るかを確認してください。",
        "取引回数が少ない候補は、単発の相場局面に依存している可能性があります。",
        "Profit Factor が1.15未満の候補は、コスト悪化で崩れやすいです。",
      ],
    },
    statistical_reliability: {
      assessment: reliabilityAssessment,
      details: reliabilityDetails,
      practical_reading:
        "この段階では、最適化の順位よりも、利益が出る領域の広さ・取引回数・コスト耐性を重視してください。",
      missing_checks: [
        "アウトオブサンプル検証",
        "ウォークフォワード検証",
        "月別・年別の損益分解",
        "ロング/ショート別の損益分解",
        "スプレッドとスリッページ悪化テスト",
      ],
    },
    spec_consistency_check: {
      summary:
        consistencyIssues.length > 0
          ? "spec.yaml と最適化結果に範囲不整合があります。"
          : "spec.yaml と最適化結果に明確な範囲不整合はありません。",
      issues: consistencyIssues,
      implication:
        consistencyIssues.length > 0
          ? "次の改善判断がずれるため、再最適化前に設定をそろえてください。"
          : "次回も最適化前に start/stop/step と生成された .set を確認してください。",
    },
    next_improvement_proposals: proposals,
    recommended_order_of_work: [
      "最良候補と上位比較候補を別期間でバックテストする。",
      "近傍パラメータでも利益が残るか確認する。",
      "月別・年別・売買方向別の偏りを確認する。",
      "コスト悪化テストを通す。",
      "条件を満たした候補だけを次の仕様改善に使う。",
    ],
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

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...省略`;
}

function pickRecordFields(source: unknown, keys: string[]): Record<string, unknown> {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }

  const record = source as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

function compactJsonForPrompt(value: unknown, maxLength = 6000): string {
  return truncateText(JSON.stringify(value, null, 2), maxLength);
}

function summarizePreviousReport(report: unknown): Record<string, unknown> | null {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return null;
  }

  const record = report as Record<string, unknown>;
  const meta = pickRecordFields(record.meta, ["generator", "analysis_mode", "analyzed_runs", "ea_name", "symbol", "timeframe"]);
  const overall = record.overall_assessment as Record<string, unknown> | undefined;
  const trends = record.common_parameter_trends as Record<string, unknown> | undefined;
  const risk = record.overfitting_risk as Record<string, unknown> | undefined;
  const reliability = record.statistical_reliability as Record<string, unknown> | undefined;

  return {
    meta,
    validation_context: record.validation_context ?? null,
    conclusion: overall?.conclusion ?? null,
    important_observations: overall?.important_observations ?? null,
    top20_summary: overall?.top20_summary ?? null,
    all_runs_summary: overall?.all_runs_summary ?? null,
    best_configuration: trends?.best_configuration ?? null,
    overfitting_risk: pickRecordFields(risk, ["risk_level", "details"]),
    statistical_reliability: pickRecordFields(reliability, ["assessment", "details", "missing_checks"]),
    next_improvement_proposals: record.next_improvement_proposals ?? null,
    recommended_order_of_work: record.recommended_order_of_work ?? null,
  };
}

function summarizeBacktestForPrompt(summary: unknown): Record<string, unknown> | null {
  const picked = pickRecordFields(summary, [
    "銘柄",
    "期間",
    "総損益",
    "プロフィットファクター",
    "期待利得",
    "リカバリファクター",
    "シャープレシオ",
    "証拠金相対ドローダウン",
    "残高相対ドローダウン",
    "取引数",
    "ショート (勝率 %)",
    "ロング (勝率 %)",
    "total net profit",
    "profit factor",
    "expected payoff",
    "recovery factor",
    "sharpe ratio",
    "total trades",
  ]);

  return Object.keys(picked).length > 0 ? picked : null;
}

async function buildCarryoverContext(projectDir: string, spec: Record<string, unknown>): Promise<string> {
  const analysisDir = path.join(projectDir, "analysis");
  const report = summarizePreviousReport(await readJsonIfExists(path.join(analysisDir, "report.json")));
  const optimizationRows = await readJsonIfExists(path.join(analysisDir, "optimization_result.json"));
  const topRows = await readJsonIfExists(path.join(analysisDir, "optimization_result.top20.json"));
  const backtestSummary = summarizeBacktestForPrompt(await readJsonIfExists(path.join(analysisDir, "backtest-summary.json")));
  const fixedSummary = summarizeBacktestForPrompt(
    await readJsonIfExists(path.join(analysisDir, "fixed-validation-summary.json")),
  );
  const eaName = String(spec.ea_name ?? "").trim();
  const sourcePath = eaName ? path.join(projectDir, "src", `${eaName}.mq5`) : "";
  const sourceInputs = sourcePath && (await exists(sourcePath)) ? await readMq5InputDefaults(sourcePath).catch(() => ({})) : {};
  const context = {
    previous_analysis_report: report,
    latest_optimization_top_rows: Array.isArray(topRows)
      ? topRows.slice(0, 5)
      : Array.isArray(optimizationRows)
        ? optimizationRows.slice(0, 5)
        : null,
    latest_backtest_summary: backtestSummary,
    latest_fixed_validation_summary: fixedSummary,
    current_ea_input_defaults: Object.keys(sourceInputs).length > 0 ? sourceInputs : null,
  };

  if (Object.values(context).every((value) => value === null)) {
    return "";
  }

  return compactJsonForPrompt(context, 12000);
}

function readOptimizationTimeframe(spec: Record<string, unknown>): string {
  const optimizationParams = readOptimizationParams(spec);
  const optimizationTimeframeParam = optimizationParams.find((item) => {
    return String(item.name ?? "").trim() === "optimization_timeframe";
  });
  const configuredTimeframe = String(
    spec.optimization_timeframe ??
      optimizationTimeframeParam?.value ??
      spec.timeframe ??
      OPTIMIZATION_TIMEFRAME,
  ).trim();

  return configuredTimeframe || OPTIMIZATION_TIMEFRAME;
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
  const beforeSpec = hadSpecBefore ? await fs.readFile(specPath, "utf8") : "";
  const latestUserMessage = [...history].reverse().find((message) => message.role === "user")?.content ?? "";
  let previousSpec: Record<string, unknown> = {};
  if (hadSpecBefore) {
    try {
      previousSpec = (YAML.parse(beforeSpec) as Record<string, unknown>) ?? {};
    } catch {
      previousSpec = {};
    }
  }
  const carryoverContext = hadSpecBefore ? await buildCarryoverContext(args.projectDir, previousSpec) : "";

  const basePrompt = `${prompt.replace("{idea_text}", args.project.idea)}

## 会話履歴
${stringifyChatHistory(history)}

${hadSpecBefore ? `## 現在の spec.yaml\n\`\`\`yaml\n${beforeSpec}\n\`\`\`\n` : ""}

${carryoverContext ? `## 前回結果・引き継ぎコンテキスト\n\`\`\`json\n${carryoverContext}\n\`\`\`\n` : ""}

## 追加ルール
- ユーザーへの返答は必ず日本語にすること
- spec.yaml のキー名は英語のまま、値や説明は日本語にすること
- 既存の spec.yaml がある場合は、会話履歴の修正依頼を反映して更新すること
- 既存の spec.yaml がある場合は、変更が必要な箇所だけを更新し、不要な部分は維持すること
- 最新のユーザー要望が既存 spec.yaml にまだ反映されていない場合、spec.yaml を必ず書き換えること
- 前回結果・引き継ぎコンテキストがある場合は、前回の最良候補、リスク、未検証項目、次の改善提案を仕様更新の判断材料にすること
- 前回結果を使った改善では、spec.yaml に research_context または validation_plan を追加・更新し、何を引き継いだかを残すこと
- 「改善」「次へ」「この候補で検証」など曖昧な依頼では、前回レポートの next_improvement_proposals と recommended_order_of_work を優先すること
- 前回と同じ最適化範囲をそのまま再実行するだけの変更は避け、固定検証・別期間検証・範囲の狭め込みなど目的が分かる形にすること
- 不明点があれば質問だけを返してください
- 仕様が確定しているなら spec.yaml を生成または更新してください`;

  async function runSpecGeneration(extraInstructions = "") {
    return callCodex({
      prompt: `${basePrompt}${extraInstructions ? `\n\n## 追加指示\n${extraInstructions}` : ""}`,
      writableFiles: [specPath],
      readOnlyFiles: [],
      workDir: args.projectDir,
      timeoutMs: args.config.codex.timeout_seconds * 1000,
      command: args.config.codex.command,
      approvalMode: args.config.codex.approval_mode,
    });
  }

  args.onProgress("Codex で仕様書を生成します");
  let result = await runSpecGeneration();

  if (hadSpecBefore && (await exists(specPath))) {
    const firstPassSpec = await fs.readFile(specPath, "utf8");
    const unchanged = firstPassSpec.trim() === beforeSpec.trim();
    if (unchanged && latestUserMessage.trim()) {
      args.onProgress("仕様書が更新されなかったため、改善指示を強めて再生成します");
      result = await runSpecGeneration(
        [
          "最新のユーザー要望が既存 spec.yaml に反映されていませんでした。",
          "既存 spec.yaml と最新の要望の差分を必ず spec.yaml に反映してください。",
          "特に、最新のユーザー要望のうちロジック変更・フィルター追加・最適化範囲変更はそのまま spec.yaml に落とし込んでください。",
          "変更が 1 行もない場合は失敗です。spec.yaml を必ず更新してください。",
          `最新のユーザー要望:\n${latestUserMessage}`,
        ].join("\n"),
      );
    }
  }

  if (await exists(specPath)) {
    const afterSpec = await fs.readFile(specPath, "utf8");
    const changedSpec = !hadSpecBefore || afterSpec.trim() !== beforeSpec.trim();
    const latestWasUserRequest = latestUserMessage.trim().length > 0;

    if (!changedSpec && hadSpecBefore && latestWasUserRequest) {
      const message =
        "改善指示は受け取りましたが、仕様書に変更が反映されませんでした。どの項目をどう変えるかを、もう少し具体的に書いてください。";

      await args.store.appendChat(args.project.id, {
        role: "assistant",
        phase: 0,
        content: message,
      });

      return {
        success: true,
        artifacts: [specPath, ...result.changedFiles],
        waitingForInput: true,
        message,
      };
    }

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
  const sourceWasCurrent = await isFileAtLeastAsNewAs(sourcePath, specPath);
  const sourceBefore = await readTextIfExists(sourcePath);

  if (sourceWasCurrent) {
    args.onProgress("既に生成済みの EA ソースをコンパイル確認します");
    const compile = await compileExpert({
      metaEditorPath: args.config.mt5.metaeditor_path,
      sourceFile: sourcePath,
      logDir: path.join(args.projectDir, "build"),
      timeoutMs: args.config.codex.timeout_seconds * 1000,
    });

    if (compile.success) {
      return {
        success: true,
        artifacts: [sourcePath, compile.logPath],
      };
    }
  }

  let lastCompileError = "";
  for (let attempt = 1; attempt <= args.config.pipeline.compile_max_retry; attempt += 1) {
    args.onProgress(`EA コードを生成します (${attempt}/${args.config.pipeline.compile_max_retry})`);
    const attemptPrompt = `${prompt}

## 追加コンテキスト
- spec.yaml path: ${specPath}
- テンプレート path: ${baseTemplatePath}
- 出力先: ${sourcePath}

${sourceBefore.trim() ? `## 既存EAソースの扱い\n- 出力先には既存の .mq5 があります。必ず現在のファイルを読んだうえで、spec.yaml の変更点をEAコードに反映してください。\n- 仕様更新後にロジック・input・固定値・検証対象が変わっている場合、古いソースをそのまま再利用しないでください。\n` : ""}

${lastCompileError ? `## 直前のコンパイルエラー\n${lastCompileError}` : ""}`;

    let changedFiles: string[] = [];
    try {
      const result = await callCodex({
        prompt: attemptPrompt,
        writableFiles: [sourcePath],
        readOnlyFiles: [specPath, baseTemplatePath],
        workDir: args.projectDir,
        timeoutMs: args.config.codex.timeout_seconds * 1000,
        command: args.config.codex.command,
        approvalMode: args.config.codex.approval_mode,
      });
      changedFiles = result.changedFiles;
    } catch (error) {
      if (!(await hasUsableFile(sourcePath))) {
        throw error;
      }

      args.onProgress("Codex はタイムアウトしましたが、EA ソースが生成済みのためコンパイル確認へ進みます");
      changedFiles = [sourcePath];
    }

    const sourceAfter = await readTextIfExists(sourcePath);
    if (sourceBefore.trim() && !sourceWasCurrent && sourceAfter.trim() === sourceBefore.trim()) {
      const message =
        "spec.yaml は更新されていますが、EA ソースが前回から変わっていません。古いEAのまま進まないよう停止しました。仕様変更を反映して .mq5 を再生成してください。";
      lastCompileError = message;

      if (attempt < args.config.pipeline.compile_max_retry) {
        args.onProgress("EA ソースが更新されなかったため、再生成を要求します");
        continue;
      }

      return {
        success: true,
        artifacts: [specPath, sourcePath, ...changedFiles],
        waitingForInput: true,
        message,
      };
    }

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
        artifacts: [sourcePath, compile.logPath, ...changedFiles],
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
  await removeArtifacts([mt5ReportPath, reportPath, summaryPath]);

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
  const resultPath = path.join(args.projectDir, "analysis", "optimization_result.json");
  const fixedSummaryPath = path.join(args.projectDir, "analysis", "fixed-validation-summary.json");
  const top20Path = path.join(args.projectDir, "analysis", "optimization_result.top20.json");
  const analysisReportPath = path.join(args.projectDir, "analysis", "report.json");
  const sourceMq5Path = path.join(args.projectDir, "src", `${eaName}.mq5`);
  const sourceEx5Path = await resolveCompiledExpertPath(args.projectDir, eaName);
  const optimizationTimeframe = readOptimizationTimeframe(spec);
  const currentValues = await readMq5InputDefaults(sourceMq5Path);
  const history = await args.store.readChat(args.project.id);
  const latestUserMessage = [...history].reverse().find((message) => message.role === "user")?.content ?? "";
  const optimizationPlan = buildOptimizationPlan(spec, OPTIMIZATION_MAX_PASSES, {
    fixedValidation: wantsFixedValidation(latestUserMessage),
  });
  const reportKind = optimizationPlan.mode === "fixed_validation" ? "fixed-validation" : "optimization";
  const reportExtension = optimizationPlan.mode === "fixed_validation" ? "htm" : "xml";
  const reportPath = path.join(args.projectDir, "reports", `${eaName}-${reportKind}.${reportExtension}`);
  const mt5ReportRelativePath = path
    .join("reports", `${args.project.id}-${reportKind}.${reportExtension}`)
    .replaceAll("/", "\\");
  const mt5ReportPath = path.join(args.config.mt5.data_folder, mt5ReportRelativePath);
  const testerInputValues =
    optimizationPlan.mode === "fixed_validation"
      ? { ...currentValues, ...fixedValuesAsCurrentInputs(optimizationPlan.fixedValues) }
      : currentValues;
  await removeArtifacts([mt5ReportPath, reportPath, resultPath, fixedSummaryPath, top20Path, analysisReportPath]);

  args.onProgress("最適化設定を生成します");
  const deployment = await deployExpertToMt5({
    sourceEx5Path,
    environment: args.config,
    deployFileName: `${args.project.id}.ex5`,
  });
  if (optimizationPlan.mode === "fixed_validation") {
    args.onProgress(`固定候補 ${JSON.stringify(optimizationPlan.fixedValues)} を1点検証します`);
  } else {
    args.onProgress(
      `最適化候補数を ${optimizationPlan.originalPasses.toLocaleString()} から ${optimizationPlan.limitedPasses.toLocaleString()} に制限します`,
    );
  }
  await writeMt5Config({
    templatePath: resolveRoot(
      "templates",
      optimizationPlan.mode === "fixed_validation" ? "tester.ini.template" : "optimization.ini.template",
    ),
    outputPath: iniPath,
    expertPath: deployment.expertConfigPath,
    symbol: String(spec.symbol ?? "USDJPY"),
    timeframe: optimizationTimeframe,
    reportPath: mt5ReportRelativePath,
    config: args.config,
    testerInputs: buildTesterInputsSection(
      optimizationPlan.params,
      testerInputValues,
      { optimize: optimizationPlan.mode !== "fixed_validation" },
    ),
    model: OPTIMIZATION_MODEL,
  });
  await writeOptimizationSetFile({
    outputPath: setPath,
    optimizationParams: optimizationPlan.params,
    currentValues: testerInputValues,
    optimize: optimizationPlan.mode !== "fixed_validation",
  });
  const deployedSetPath = await deployTesterProfile({
    sourcePath: setPath,
    environment: args.config,
    targetFileName: `${args.project.id}.set`,
  });

  args.onProgress(optimizationPlan.mode === "fixed_validation" ? "MT5 固定検証を起動します" : "MT5 最適化を起動します");
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
        ? `検証レポートが生成されませんでした。\n${testerLog.split(/\r?\n/).slice(-20).join("\n")}`
        : "検証レポートが生成されませんでした。",
    };
  }

  args.onProgress(optimizationPlan.mode === "fixed_validation" ? "固定検証レポートを解析します" : "最適化レポートを解析します");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.copyFile(mt5ReportPath, reportPath);
  const rows =
    optimizationPlan.mode === "fixed_validation"
      ? buildFixedValidationRows(await parseBacktestHtml(reportPath), optimizationPlan.fixedValues)
      : await parseOptimizerXml(reportPath);
  if (optimizationPlan.mode === "fixed_validation") {
    await fs.writeFile(
      fixedSummaryPath,
      JSON.stringify(await parseBacktestHtml(reportPath), null, 2),
      "utf8",
    );
  }
  if (rows.length === 0) {
    const testerLog = await readLatestTesterLog(args.config.mt5.data_folder);
    return {
      success: false,
      artifacts: [iniPath, setPath, deployedSetPath, deployment.deployedPath, reportPath],
      error: testerLog
        ? `検証レポートは生成されましたが、結果行が 0 件です。\n${testerLog.split(/\r?\n/).slice(-20).join("\n")}`
        : "検証レポートは生成されましたが、結果行が 0 件です。",
    };
  }
  await fs.writeFile(resultPath, JSON.stringify(rows, null, 2), "utf8");

  if (!hasNonZeroOptimizationTrades(rows)) {
    return {
      success: true,
      waitingForInput: true,
      message: "最適化は完了しましたが、取引回数が 0 の候補しかありませんでした。AI 分析には進まず、仕様書を見直してください。",
      artifacts: [iniPath, setPath, deployedSetPath, deployment.deployedPath, reportPath, resultPath],
    };
  }

  return {
    success: true,
    artifacts:
      optimizationPlan.mode === "fixed_validation"
        ? [iniPath, setPath, deployedSetPath, deployment.deployedPath, reportPath, fixedSummaryPath, resultPath]
        : [iniPath, setPath, deployedSetPath, deployment.deployedPath, reportPath, resultPath],
  };
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
  await removeArtifacts([reportPath, top20Path]);
  await fs.writeFile(top20Path, JSON.stringify(top20, null, 2), "utf8");

  args.onProgress("固定スキーマで最適化結果を分析します");
  const stableReport = buildStableAnalysisReport({
    spec: await loadSpec(args.projectDir),
    rows: optimization,
  });
  await fs.writeFile(reportPath, JSON.stringify(stableReport, null, 2), "utf8");
  return { success: true, artifacts: [reportPath, top20Path] };

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
      reason: errorToMessage(error),
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
