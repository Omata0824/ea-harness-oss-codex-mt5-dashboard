export function renderAnalysis(
  project,
  analysisEntries,
  improvementDraft = { selected: [], customNote: "" },
  activeTab = "report",
) {
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
  const analysisStatus = deriveAnalysisStatus(project);
  const tabs = buildAnalysisTabs({ backtest, optimization, report, analysisEntries, analysisStatus });
  const normalizedTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id ?? "report";

  return `
    <section class="analysis-layout">
      ${renderAnalysisTabs(tabs, normalizedTab)}
      <section class="analysis-tab-panel ${normalizedTab === "backtest" ? "is-active" : ""}" data-analysis-panel="backtest">
        ${renderSnapshotNotice(project)}
        ${renderBacktestSummary(backtest)}
      </section>
      <section class="analysis-tab-panel ${normalizedTab === "optimization" ? "is-active" : ""}" data-analysis-panel="optimization">
        ${renderSnapshotNotice(project)}
        ${renderOptimizationSummary(optimization)}
      </section>
      <section class="analysis-tab-panel ${normalizedTab === "report" ? "is-active" : ""}" data-analysis-panel="report">
        ${renderSnapshotNotice(project)}
        ${renderAnalysisReport(project, report, improvementDraft, analysisStatus)}
      </section>
      <section class="analysis-tab-panel ${normalizedTab === "raw" ? "is-active" : ""}" data-analysis-panel="raw">
        ${renderSnapshotNotice(project)}
        ${renderRawAnalysisFiles(analysisEntries)}
      </section>
    </section>
  `;
}

function buildAnalysisTabs({ backtest, optimization, report, analysisEntries, analysisStatus }) {
  return [
    { id: "backtest", label: "バックテスト", visible: Boolean(backtest) && Object.keys(backtest).length > 0 },
    { id: "optimization", label: "最適化", visible: Array.isArray(optimization) && optimization.length > 0 },
    {
      id: "report",
      label: analysisStatus.isFresh ? "AI分析" : "AI分析待ち",
      visible: (Boolean(report) && Object.keys(report).length > 0) || analysisStatus.showPlaceholder,
    },
    { id: "raw", label: "生データ", visible: Array.isArray(analysisEntries) && analysisEntries.length > 0 },
  ].filter((tab) => tab.visible);
}

function renderAnalysisTabs(tabs, activeTab) {
  if (!tabs.length) {
    return "";
  }

  return `
    <div class="analysis-subtabs" role="tablist" aria-label="分析詳細">
      ${tabs
        .map(
          (tab) => `
            <button
              class="analysis-subtab ${tab.id === activeTab ? "is-active" : ""}"
              data-analysis-tab="${tab.id}"
              type="button"
            >
              ${escapeHtml(tab.label)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderSnapshotNotice(project) {
  if (!project.viewingSnapshot) {
    return "";
  }

  return `
    <article class="analysis-card">
      <h3>表示中の版</h3>
      <p class="project-meta">この画面は保存済みバージョン ${escapeHtml(project.viewingSnapshot.createdAt)} を表示しています。</p>
    </article>
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

function renderAnalysisReport(project, report, improvementDraft, analysisStatus) {
  if (!analysisStatus.isFresh) {
    return `
      <article class="analysis-card analysis-report-card">
        <div class="analysis-head">
          <h3>AI 分析</h3>
          <span class="status-badge">${escapeHtml(analysisStatus.badge)}</span>
        </div>
        <section class="report-section report-hero">
          <div class="report-section-label">状態</div>
          <p class="report-lead">${escapeHtml(analysisStatus.message)}</p>
        </section>
      </article>
    `;
  }

  if (!report || Object.keys(report).length === 0) {
    return `
      <article class="analysis-card analysis-report-card">
        <div class="analysis-head">
          <h3>AI 分析</h3>
          <span class="status-badge">未生成</span>
        </div>
        <section class="report-section report-hero">
          <div class="report-section-label">状態</div>
          <p class="report-lead">AI 分析結果はまだありません。最適化完了後に生成されます。</p>
        </section>
      </article>
    `;
  }

  const normalized = normalizeAnalysisReport(report);

  const conclusion =
    normalized.conclusion ||
    pickValue(report, [
      "summary.overall_assessment",
      "overall_assessment.conclusion",
      "summary",
      "conclusion",
    ]) || "分析レポートを取得しました。";

  const meta = normalized.meta;
  const overall = normalized.overall;
  const trend = normalized.trend;
  const risk = normalized.risk;
  const reliability = normalized.reliability;
  const proposals = [
    ...normalized.proposals,
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
    ["対象EA", meta?.ea_name],
    ["対象通貨", meta?.symbol],
    ["探索候補数", meta?.search_space_size],
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
                  .map((item, index) => {
                    const proposal = asObject(item) || {};
                    const proposalId = `proposal-${index}`;
                    const selected = Array.isArray(improvementDraft.selected) && improvementDraft.selected.includes(proposalId);
                    return `
                      <label class="report-action-card report-action-selectable ${selected ? "is-selected" : ""}">
                        <div class="proposal-check">
                          <input type="checkbox" data-improvement-index="${proposalId}" ${selected ? "checked" : ""} />
                          <span>この改善案を使う</span>
                        </div>
                        <div class="report-action-head">
                          <h4>${escapeHtml(proposal.title ?? "改善案")}</h4>
                          ${proposal.priority ? `<span class="status-badge">${escapeHtml(proposal.priority)}</span>` : ""}
                        </div>
                        ${proposal.action ? `<p>${escapeHtml(proposal.action)}</p>` : ""}
                        ${proposal.logic_change ? `<p>${escapeHtml(proposal.logic_change)}</p>` : ""}
                        ${proposal.reason || proposal.why ? `<p class="project-meta">${escapeHtml(proposal.reason ?? proposal.why)}</p>` : ""}
                      </label>
                    `;
                  })
                  .join("")}
              </div>
            </section>
          `
          : ""
      }

      ${renderImprovementComposer(project, proposals, improvementDraft)}
    </article>
  `;
}

function deriveAnalysisStatus(project) {
  const successfulPhase3 = latestSuccessfulPhase(project, 3);
  const successfulPhase4 = latestSuccessfulPhase(project, 4);
  const isFresh =
    !successfulPhase3 ||
    (successfulPhase4 && String(successfulPhase4.completedAt) >= String(successfulPhase3.completedAt));

  if (project.state.currentPhase === 4 && project.state.status === "running") {
    return {
      isFresh: false,
      showPlaceholder: true,
      badge: "生成中",
      message: "AI 分析を実行中です。完了するとここに今回の分析結果が表示されます。",
    };
  }

  if (
    project.state.currentPhase === 3 &&
    project.state.status === "waiting_approval" &&
    project.state.awaitingApproval === "optimization_complete"
  ) {
    return {
      isFresh: false,
      showPlaceholder: true,
      badge: "開始待ち",
      message: "今回の最適化結果に対する AI 分析はまだ実行していません。承認すると AI 分析を開始します。",
    };
  }

  if (!isFresh) {
    return {
      isFresh: false,
      showPlaceholder: true,
      badge: "更新待ち",
      message: "前回の AI 分析は古いため非表示にしています。今回の分析が完了すると新しい結果に切り替わります。",
    };
  }

  return {
    isFresh: true,
    showPlaceholder: Boolean(successfulPhase4),
    badge: "結果あり",
    message: "",
  };
}

function normalizeAnalysisReport(report) {
  const meta = asObject(report.meta);
  const trend =
    asObject(report.common_parameter_trends) ||
    asObject(report.analysis?.common_parameter_trends) ||
    findObjectByNestedKeys(report, ["最良設定", "パラメータ別集計"]);
  const risk =
    asObject(report.overfitting_risk) ||
    asObject(report.analysis?.overfitting_risk) ||
    findObjectByNestedKeys(report, ["評価", "根拠"]);
  const reliability =
    asObject(report.statistical_reliability) ||
    asObject(report.analysis?.statistical_reliability) ||
    findObjectByNestedKeys(report, ["評価", "判断理由"]);
  const bestConfigSource = asObject(trend?.best_configuration) || asObject(trend?.["最良設定"]);
  const parameterSummaries = asObject(trend?.["パラメータ別集計"]);
  const japaneseProposals = findProposalArray(report);
  const parameterEntries = bestConfigSource
    ? Object.entries(bestConfigSource).filter(([key]) =>
        !["Profit", "Profit Factor", "Recovery Factor", "Sharpe Ratio", "Equity DD %", "Trades"].includes(key),
      )
    : [];

  return {
    conclusion: pickFirst(report, ["結論", "meta.総評"]),
    meta: {
      analysis_date: meta?.analysis_date,
      analyzed_runs: meta?.analyzed_runs ?? meta?.analyzed_cases,
      top_runs_used_for_pattern_review: meta?.top_runs_used_for_pattern_review,
      backtest_period_reference: meta?.backtest_period_reference,
      ea_name: meta?.["対象EA"],
      symbol: meta?.["対象通貨"],
      search_space_size: meta?.["探索候補数"],
    },
    overall: {
      important_observations: asArray(findValueByKey(report, "初期仕様との比較")),
      critical_findings: asArray(findValueByKey(report, "共通傾向")),
    },
    trend: {
      best_configuration: bestConfigSource
        ? {
            profit: bestConfigSource.Profit,
            profit_factor: bestConfigSource["Profit Factor"],
            equity_dd_pct: bestConfigSource["Equity DD %"],
            trades: bestConfigSource.Trades,
            params: Object.fromEntries(parameterEntries),
          }
        : null,
      details: parameterSummaries
        ? Object.entries(parameterSummaries).map(([parameter, rows]) => ({
            parameter,
            interpretation: summarizeParameterRows(rows),
          }))
        : [],
    },
    risk: {
      risk_level: risk?.risk_level ?? risk?.["評価"],
      details: asArray(risk?.details),
      reasons: uniqueList([...asArray(risk?.reasons), ...asArray(risk?.["根拠"])]),
      specific_examples: uniqueList(
        [...asArray(risk?.specific_examples), ...asArray(risk?.["解釈"] ? [risk["解釈"]] : [])],
      ),
    },
    reliability: {
      assessment: reliability?.assessment ?? reliability?.["評価"],
      details: uniqueList([...asArray(reliability?.details), ...asArray(reliability?.["判断理由"])]),
      practical_reading: reliability?.practical_reading,
      trust_conclusion: asArray(reliability?.["制約"]).join(" "),
    },
    proposals: japaneseProposals.map((proposal) => ({
      title: proposal["施策"],
      action: proposal["施策"],
      reason: proposal["理由"],
      priority: proposal["優先度"],
    })),
  };
}

function summarizeParameterRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "";
  }

  return rows
    .slice(0, 3)
    .map((row) => {
      const item = asObject(row) || {};
      return Object.entries(item)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
    })
    .filter(Boolean)
    .join(" / ");
}

function findValueByKey(source, key) {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  if (key in source) {
    return source[key];
  }

  for (const value of Object.values(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && key in value) {
      return value[key];
    }
  }

  return undefined;
}

function findObjectByNestedKeys(source, keys) {
  if (!source || typeof source !== "object") {
    return null;
  }

  for (const value of Object.values(source)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    if (keys.every((key) => key in value)) {
      return value;
    }
  }

  return null;
}

function findProposalArray(source) {
  if (!source || typeof source !== "object") {
    return [];
  }

  for (const value of Object.values(source)) {
    if (!Array.isArray(value) || value.length === 0) {
      continue;
    }

    const first = asObject(value[0]);
    if (first && ("施策" in first || "理由" in first || "優先度" in first)) {
      return value.map((item) => asObject(item) || {}).filter((item) => Object.keys(item).length > 0);
    }
  }

  return [];
}

function pickFirst(source, paths) {
  for (const pathText of paths) {
    const value = readPath(source, pathText);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
}

function latestSuccessfulPhase(project, phase) {
  return [...(project?.state?.phaseHistory ?? [])]
    .reverse()
    .find((entry) => entry.phase === phase && entry.success);
}

function renderImprovementComposer(project, proposals, improvementDraft) {
  if (project.viewingSnapshot) {
    return `
      <section class="report-section">
        <div class="report-section-label">再作成</div>
        <p class="project-meta">保存済みバージョン表示中は再作成できません。最新版に戻してください。</p>
      </section>
    `;
  }

  const selectedCount = Array.isArray(improvementDraft.selected) ? improvementDraft.selected.length : 0;
  const proposalsCount = Array.isArray(proposals) ? proposals.length : 0;
  const isRecoveryMode = project.state.status === "error" && project.state.currentPhase === 0;

  return `
    <section class="report-section improvement-composer" id="improvement-composer">
      <div class="report-section-label">改善条件を選んで仕様書を作り直す</div>
      <p class="project-meta">
        分析で出た改善案を選び、必要なら追記してから再実験します。
        保存版を作成したあと、仕様書の作り直しから始めます。
      </p>
      ${
        isRecoveryMode
          ? `
            <p class="project-meta">
              いまは再生成途中で止まっていますが、前回の分析結果は残っています。この内容から改善条件を選んで再開できます。
            </p>
          `
          : ""
      }
      <div class="report-info-grid">
        <div class="report-info-card">
          <div class="metric-label">選択した改善案</div>
          <div class="metric-value">${escapeHtml(String(selectedCount))}</div>
        </div>
        <div class="report-info-card">
          <div class="metric-label">候補数</div>
          <div class="metric-value">${escapeHtml(String(proposalsCount))}</div>
        </div>
      </div>
      <div class="field">
        <label for="improvement-custom-note">自分で追加したい指示</label>
        <textarea id="improvement-custom-note" rows="6" placeholder="例: H1 の EMA 傾きで強トレンド中は逆張りしないでください。">${escapeHtml(
          improvementDraft.customNote ?? "",
        )}</textarea>
        <p class="field-note">空でも進められます。選んだ改善案に補足したい内容だけ書いてください。</p>
      </div>
      <div class="inline-actions">
        <button id="apply-improvement-plan" type="button">この内容で仕様書を作り直す</button>
      </div>
    </section>
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
