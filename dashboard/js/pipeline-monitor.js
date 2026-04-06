const PHASE_NAMES = [
  "Phase 0 仕様",
  "Phase 1 生成とコンパイル",
  "Phase 2 バックテスト",
  "Phase 3 最適化",
  "Phase 4 分析",
];

export function renderPipelineMonitor(project) {
  if (!project) {
    return '<p class="project-meta">プロジェクトを選択してください。</p>';
  }

  const latestResult = project.state.phaseHistory.at(-1);
  const currentStatus = statusLabel(project.state.status);
  const helpText = statusHelp(project);

  return `
    <div class="pipeline-layout">
      <article class="status-card">
        <strong>現在の状態</strong>
        <div class="project-meta">現在フェーズ: ${PHASE_NAMES[project.state.currentPhase]}</div>
        <div class="status-badge">${currentStatus}</div>
        <p class="status-help">${escapeHtml(helpText)}</p>
      </article>

      <div class="phase-grid">
        ${PHASE_NAMES.map((label, index) => {
          const history = project.state.phaseHistory.filter((item) => item.phase === index);
          const latest = history.at(-1);
          const state =
            index < project.state.currentPhase
              ? "完了"
              : index === project.state.currentPhase
                ? currentStatus
                : "未実行";
          return `
            <article class="phase-card ${index === project.state.currentPhase ? "is-current" : ""}">
              <strong>${label}</strong>
              <div class="phase-state">${state}</div>
              <div class="project-meta">${latest?.completedAt ?? "まだ実行されていません"}</div>
            </article>
          `;
        }).join("")}
      </div>

      ${project.spec ? `
        <article class="spec-card">
          <h3>生成された仕様書 spec.yaml</h3>
          <pre>${escapeHtml(project.spec)}</pre>
        </article>
      ` : ""}

      ${latestResult?.artifacts?.length ? `
        <article class="artifact-card">
          <h3>最新アーティファクト</h3>
          <div class="artifact-list">
            ${latestResult.artifacts.map((artifact) => `<div class="artifact-item">${escapeHtml(artifact)}</div>`).join("")}
          </div>
        </article>
      ` : ""}
    </div>
  `;
}

function statusLabel(status) {
  switch (status) {
    case "idle":
      return "待機中";
    case "running":
      return "実行中";
    case "waiting_approval":
      return "承認待ち";
    case "waiting_input":
      return "入力待ち";
    case "error":
      return "エラー";
    case "completed":
      return "完了";
    case "stopped":
      return "停止中";
    default:
      return status;
  }
}

function statusHelp(project) {
  if (project.state.status === "waiting_approval" && project.state.awaitingApproval === "spec_approved") {
    return "仕様書が生成されています。内容を確認して問題なければ右上の「承認」を押してください。";
  }
  if (project.state.status === "running") {
    return "現在処理を実行しています。ログやフェーズ表示が更新されるまで少し待ってください。";
  }
  if (project.state.status === "waiting_input") {
    return "Codex から質問が返っています。チャットタブで内容を確認して回答してください。";
  }
  if (project.state.status === "error") {
    return `処理が停止しました。${project.state.lastError ?? "ログを確認して再実行してください。"}`;
  }
  if (project.state.status === "completed") {
    return "パイプラインは完了しています。分析タブも確認してください。";
  }
  return "プロジェクトの状態はここに表示されます。";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
