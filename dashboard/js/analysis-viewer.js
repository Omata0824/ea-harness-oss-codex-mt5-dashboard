export function renderAnalysis(project, analysisEntries) {
  if (!project) {
    return '<p class="project-meta">プロジェクトを選択してください。</p>';
  }

  if (!analysisEntries.length) {
    return '<p class="project-meta">分析ファイルはまだありません。</p>';
  }

  const byName = Object.fromEntries(
    analysisEntries.map((entry) => [entry.fileName, safeParse(entry.contents)]),
  );

  const backtest = asObject(byName["backtest-summary.json"]);
  const optimization = asArray(byName["optimization_result.json"]);
  const report = asObject(byName["report.json"]);

  return `
    <section class="analysis-layout">
      ${renderBacktestSummary(backtest)}
      ${renderOptimizationSummary(optimization)}
      ${renderAnalysisReport(report)}
      ${renderRawAnalysisFiles(analysisEntries)}
    </section>
  `;
}

function renderBacktestSummary(summary) {
  if (!summary || Object.keys(summary).length === 0) {
    return `
      <article class="analysis-card">
        <h3>バックテスト概要</h3>
        <p class="project-meta">バックテスト結果はまだありません。</p>
      </article>
    `;
  }

  const items = [
    ["純利益", pickValue(summary, ["純利益", "総損益", "total net profit"])],
    ["プロフィットファクター", pickValue(summary, ["プロフィットファクター", "profit factor"])],
    ["期待利得", pickValue(summary, ["期待利得", "expected payoff"])],
    ["取引数", pickValue(summary, ["取引数", "trades"])],
    ["最大ドローダウン", pickValue(summary, ["最大ドローダウン", "証拠金最大ドローダウン", "equity drawdown maximal"])],
    ["相対ドローダウン", pickValue(summary, ["相対ドローダウン", "証拠金相対ドローダウン", "equity drawdown relative"])],
  ];

  return `
    <article class="analysis-card">
      <h3>バックテスト概要</h3>
      <div class="metric-grid">
        ${items
          .map(
            ([label, value]) => `
              <div class="metric-card">
                <div class="metric-label">${escapeHtml(label)}</div>
                <div class="metric-value">${escapeHtml(value || "-")}</div>
              </div>
            `,
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderOptimizationSummary(rows) {
  if (!rows.length) {
    return `
      <article class="analysis-card">
        <h3>最適化結果</h3>
        <p class="project-meta">最適化結果はまだありません。</p>
      </article>
    `;
  }

  const mainColumns = [
    "Pass",
    "Result",
    "Profit",
    "Profit Factor",
    "Recovery Factor",
    "Sharpe Ratio",
    "Equity DD %",
    "Trades",
  ];

  const sortedRows = [...rows].sort(compareOptimizationRows);
  const topRows = sortedRows.slice(0, 20);
  const parameterColumns = Object.keys(topRows[0] ?? {}).filter((key) => !mainColumns.includes(key));

  return `
    <article class="analysis-card">
      <div class="analysis-head">
        <h3>最適化結果</h3>
        <span class="status-badge">${rows.length} 件</span>
      </div>
      <div class="table-wrap">
        <table class="analysis-table">
          <thead>
            <tr>
              <th>Pass</th>
              <th>Result</th>
              <th>Profit</th>
              <th>PF</th>
              <th>Recovery</th>
              <th>Sharpe</th>
              <th>DD %</th>
              <th>Trades</th>
              <th>パラメータ</th>
            </tr>
          </thead>
          <tbody>
            ${topRows
              .map(
                (row) => `
                  <tr>
                    <td>${escapeHtml(row.Pass ?? "")}</td>
                    <td>${escapeHtml(row.Result ?? "")}</td>
                    <td>${escapeHtml(row.Profit ?? "")}</td>
                    <td>${escapeHtml(row["Profit Factor"] ?? "")}</td>
                    <td>${escapeHtml(row["Recovery Factor"] ?? "")}</td>
                    <td>${escapeHtml(row["Sharpe Ratio"] ?? "")}</td>
                    <td>${escapeHtml(row["Equity DD %"] ?? "")}</td>
                    <td>${escapeHtml(row.Trades ?? "")}</td>
                    <td>${renderParameterList(row, parameterColumns)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function renderParameterList(row, parameterColumns) {
  const items = parameterColumns
    .map((key) => {
      const value = row[key];
      if (value === null || value === undefined || value === "") {
        return "";
      }

      return `<div class="parameter-item"><span class="parameter-key">${escapeHtml(key)}</span><span class="parameter-value">${escapeHtml(value)}</span></div>`;
    })
    .filter(Boolean);

  if (!items.length) {
    return '<span class="project-meta">パラメータなし</span>';
  }

  return `<div class="parameter-list">${items.join("")}</div>`;
}

function renderAnalysisReport(report) {
  if (!report || Object.keys(report).length === 0) {
    return "";
  }

  const conclusion =
    pickValue(report, [
      "summary.overall_assessment",
      "overall_assessment.conclusion",
      "summary",
      "conclusion",
    ]) || "分析レポートを取得しました。";

  const meta = asObject(report.meta);
  const overall = asObject(report.overall_assessment);
  const trend = asObject(report.common_parameter_trends) || asObject(report.analysis?.common_parameter_trends);
  const risk = asObject(report.overfitting_risk) || asObject(report.analysis?.overfitting_risk);
  const reliability = asObject(report.statistical_reliability) || asObject(report.analysis?.statistical_reliability);
  const proposals = [
    ...asArray(report.next_improvement_proposals),
    ...asArray(report.analysis?.improvement_proposals),
  ];

  const infoCards = [
    ["分析日", meta?.analysis_date],
    ["分析件数", meta?.analyzed_runs ?? meta?.analyzed_cases],
    ["上位評価件数", meta?.top_runs_used_for_pattern_review],
    ["期間", meta?.backtest_period_reference],
    ["過剰最適化リスク", risk?.risk_level],
    ["信頼性評価", reliability?.assessment],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");

  const observations = uniqueList([
    ...asArray(overall?.important_observations),
    ...asArray(overall?.critical_findings),
  ]).slice(0, 6);

  const trendDetails = asArray(trend?.details).slice(0, 6);
  const bestConfig = asObject(trend?.best_configuration);
  const riskDetails = uniqueList([
    ...asArray(risk?.details),
    ...asArray(risk?.reasons),
    ...asArray(risk?.specific_examples),
  ]).slice(0, 6);
  const reliabilityDetails = uniqueList([
    ...asArray(reliability?.details),
    reliability?.practical_reading,
    reliability?.trust_conclusion,
  ]).slice(0, 5);

  return `
    <article class="analysis-card analysis-report-card">
      <div class="analysis-head">
        <h3>AI 分析レポート</h3>
        <span class="status-badge">人向け要約</span>
      </div>

      <section class="report-section report-hero">
        <div class="report-section-label">結論</div>
        <p class="report-lead">${escapeHtml(conclusion)}</p>
      </section>

      ${
        infoCards.length
          ? `
            <section class="report-section">
              <div class="report-section-label">分析サマリー</div>
              <div class="report-info-grid">
                ${infoCards
                  .map(
                    ([label, value]) => `
                      <div class="report-info-card">
                        <div class="metric-label">${escapeHtml(label)}</div>
                        <div class="metric-value">${escapeHtml(value)}</div>
                      </div>
                    `,
                  )
                  .join("")}
              </div>
            </section>
          `
          : ""
      }

      ${
        observations.length
          ? `
            <section class="report-section">
              <div class="report-section-label">重要ポイント</div>
              <ul class="report-list">
                ${observations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
              </ul>
            </section>
          `
          : ""
      }

      ${
        bestConfig
          ? `
            <section class="report-section">
              <div class="report-section-label">上位設定の見え方</div>
              <div class="report-info-grid">
                <div class="report-info-card">
                  <div class="metric-label">Profit</div>
                  <div class="metric-value">${escapeHtml(bestConfig.profit ?? "-")}</div>
                </div>
                <div class="report-info-card">
                  <div class="metric-label">PF</div>
                  <div class="metric-value">${escapeHtml(bestConfig.profit_factor ?? "-")}</div>
                </div>
                <div class="report-info-card">
                  <div class="metric-label">DD %</div>
                  <div class="metric-value">${escapeHtml(bestConfig.equity_dd_pct ?? "-")}</div>
                </div>
                <div class="report-info-card">
                  <div class="metric-label">Trades</div>
                  <div class="metric-value">${escapeHtml(bestConfig.trades ?? "-")}</div>
                </div>
              </div>
              ${
                bestConfig.params
                  ? `
                    <div class="report-subsection">
                      <div class="metric-label">主なパラメータ</div>
                      <div class="parameter-list">
                        ${Object.entries(bestConfig.params)
                          .map(
                            ([key, value]) => `
                              <div class="parameter-item">
                                <span class="parameter-key">${escapeHtml(key)}</span>
                                <span class="parameter-value">${escapeHtml(value)}</span>
                              </div>
                            `,
                          )
                          .join("")}
                      </div>
                    </div>
                  `
                  : ""
              }
            </section>
          `
          : ""
      }

      ${
        trendDetails.length
          ? `
            <section class="report-section">
              <div class="report-section-label">パラメータ傾向</div>
              <div class="report-grid">
                ${trendDetails
                  .map(
                    (item) => `
                      <div class="report-note-card">
                        <h4>${escapeHtml(item.parameter ?? "パラメータ")}</h4>
                        <p>${escapeHtml(item.interpretation ?? item.summary ?? "")}</p>
                      </div>
                    `,
                  )
                  .join("")}
              </div>
            </section>
          `
          : ""
      }

      ${
        riskDetails.length
          ? `
            <section class="report-section">
              <div class="report-section-label">リスク評価</div>
              <ul class="report-list">
                ${riskDetails.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
              </ul>
            </section>
          `
          : ""
      }

      ${
        reliabilityDetails.length
          ? `
            <section class="report-section">
              <div class="report-section-label">信頼性の見方</div>
              <ul class="report-list">
                ${reliabilityDetails.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
              </ul>
            </section>
          `
          : ""
      }

      ${
        proposals.length
          ? `
            <section class="report-section">
              <div class="report-section-label">次にやること</div>
              <div class="report-grid">
                ${proposals
                  .slice(0, 6)
                  .map((item) => {
                    const proposal = asObject(item) || {};
                    return `
                      <div class="report-action-card">
                        <div class="report-action-head">
                          <h4>${escapeHtml(proposal.title ?? "改善案")}</h4>
                          ${proposal.priority ? `<span class="status-badge">${escapeHtml(proposal.priority)}</span>` : ""}
                        </div>
                        ${proposal.action ? `<p>${escapeHtml(proposal.action)}</p>` : ""}
                        ${proposal.logic_change ? `<p>${escapeHtml(proposal.logic_change)}</p>` : ""}
                        ${proposal.reason || proposal.why ? `<p class="project-meta">${escapeHtml(proposal.reason ?? proposal.why)}</p>` : ""}
                      </div>
                    `;
                  })
                  .join("")}
              </div>
            </section>
          `
          : ""
      }
    </article>
  `;
}

function renderRawAnalysisFiles(entries) {
  return `
    <details class="analysis-card raw-analysis-card">
      <summary>生データを見る</summary>
      <div class="raw-analysis-grid">
        ${entries
          .map(
            (entry) => `
              <article class="analysis-card">
                <h3>${escapeHtml(entry.fileName)}</h3>
                <pre>${escapeHtml(truncate(prettyPrint(entry.contents), 8000))}</pre>
              </article>
            `,
          )
          .join("")}
      </div>
    </details>
  `;
}

function pickValue(source, keys) {
  for (const key of keys) {
    const value = readPath(source, key);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
}

function readPath(source, pathText) {
  if (!source || !pathText) {
    return undefined;
  }

  const segments = String(pathText).split(".");
  let current = source;

  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function compareOptimizationRows(left, right) {
  const leftResult = toNumber(left.Result);
  const rightResult = toNumber(right.Result);

  if (Number.isFinite(leftResult) && Number.isFinite(rightResult) && leftResult !== rightResult) {
    return rightResult - leftResult;
  }

  const leftProfit = toNumber(left.Profit);
  const rightProfit = toNumber(right.Profit);

  if (Number.isFinite(leftProfit) && Number.isFinite(rightProfit) && leftProfit !== rightProfit) {
    return rightProfit - leftProfit;
  }

  return 0;
}

function toNumber(value) {
  const normalized = String(value ?? "")
    .replaceAll(",", "")
    .replaceAll(" ", "")
    .trim();
  return Number(normalized);
}

function prettyPrint(contents) {
  try {
    return JSON.stringify(JSON.parse(contents), null, 2);
  } catch {
    return contents;
  }
}

function truncate(value, limit) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n\n... 以下省略 ...`;
}

function safeParse(contents) {
  try {
    return JSON.parse(contents);
  } catch {
    return null;
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueList(values) {
  return values.filter((value, index, array) => value && array.indexOf(value) === index);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
