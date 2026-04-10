import { renderAnalysis } from "./analysis-viewer.js";
import { renderChatMessages } from "./chat.js";
import { renderPipelineMonitor } from "./pipeline-monitor.js";
import { renderSetupWizard } from "./setup-wizard.js";

const state = {
  projects: [],
  selectedProjectId: null,
  selectedSnapshotId: "",
  liveProject: null,
  selectedProject: null,
  messages: [],
  analysisEntries: [],
  settings: null,
  logs: [],
  analysisTabs: {},
  improvementDrafts: {},
};

const els = {
  projectList: document.querySelector("#project-list"),
  projectTitle: document.querySelector("#project-title"),
  pipelineMonitor: document.querySelector("#pipeline-monitor"),
  chatMessages: document.querySelector("#chat-messages"),
  analysisViewer: document.querySelector("#analysis-viewer"),
  setupWizard: document.querySelector("#setup-wizard"),
  eventLog: document.querySelector("#event-log"),
  mt5Status: document.querySelector("#mt5-status"),
  codexStatus: document.querySelector("#codex-status"),
  modeLabel: document.querySelector("#mode-label"),
  snapshotSelect: document.querySelector("#snapshot-select"),
  snapshotMeta: document.querySelector("#snapshot-meta"),
  startProject: document.querySelector("#start-project"),
  approveProject: document.querySelector("#approve-project"),
  retryProject: document.querySelector("#retry-project"),
  improveProject: document.querySelector("#improve-project"),
};

document.querySelector("#new-project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const payload = {
    name: formData.get("name"),
    idea: formData.get("idea"),
  };
  await api("/api/projects", { method: "POST", body: JSON.stringify(payload) });
  form.reset();
  await refreshProjects();
});

document.querySelector("#refresh-projects").addEventListener("click", () => {
  void refreshProjects();
});

document.querySelector("#start-project").addEventListener("click", () => actOnProject("start"));
document.querySelector("#approve-project").addEventListener("click", () => actOnProject("approve"));
document.querySelector("#retry-project").addEventListener("click", () => actOnProject("retry"));
document.querySelector("#improve-project").addEventListener("click", () => openImprovementComposer());

document.querySelector("#test-mt5").addEventListener("click", () => {
  void testMt5();
});

document.querySelector("#test-codex").addEventListener("click", () => {
  void testCodex();
});

document.querySelector("#save-settings").addEventListener("click", () => {
  void saveSettings();
});

document.querySelector("#mode-confirm").addEventListener("click", () => setSystemMode("confirm"));
document.querySelector("#mode-auto").addEventListener("click", () => setSystemMode("autonomous"));
els.snapshotSelect.addEventListener("change", async (event) => {
  state.selectedSnapshotId = event.currentTarget.value;
  await refreshSelectedProject();
});

document.querySelector("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedProjectId) {
    return;
  }
  const input = document.querySelector("#chat-input");
  const message = input.value.trim();
  if (!message) {
    return;
  }
  await api(`/api/projects/${state.selectedProjectId}/chat`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  state.logs.push(`[chat:send] ${message}`);
  input.value = "";
  await refreshSelectedProject();
});

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    const tabName = button.dataset.tab;
    document.querySelectorAll(".tab").forEach((node) => node.classList.remove("is-active"));
    document.querySelectorAll(".tab-panel").forEach((node) => node.classList.remove("is-active"));
    button.classList.add("is-active");
    document.querySelector(`[data-panel="${tabName}"]`).classList.add("is-active");
  });
});

async function bootstrap() {
  await Promise.all([refreshSettings(), refreshProjects()]);
  initWebSocket();
}

async function refreshSettings() {
  const payload = await api("/api/settings");
  state.settings = payload.config;
  renderSettings();
  els.modeLabel.textContent = modeLabel(payload.config.pipeline.mode);
}

async function refreshProjects() {
  state.projects = await api("/api/projects");
  if (!state.selectedProjectId && state.projects.length) {
    state.selectedProjectId = state.projects[0].id;
  }
  renderProjectList();
  await refreshSelectedProject();
}

async function refreshSelectedProject() {
  if (!state.selectedProjectId) {
    state.liveProject = null;
    state.selectedProject = null;
    state.messages = [];
    state.analysisEntries = [];
    state.selectedSnapshotId = "";
    render();
    return;
  }

  state.liveProject = await api(`/api/projects/${state.selectedProjectId}`);
  syncSnapshotSelection();

  if (state.selectedSnapshotId) {
    const payload = await api(`/api/projects/${state.selectedProjectId}/snapshots/${state.selectedSnapshotId}`);
    state.selectedProject = {
      ...payload.project,
      snapshots: state.liveProject.snapshots,
      viewingSnapshot: payload.snapshot,
      liveProject: state.liveProject,
    };
    state.messages = payload.messages;
    state.analysisEntries = payload.analysisEntries;
    state.selectedProject.spec = payload.spec;
  } else {
    state.selectedProject = state.liveProject;
    state.messages = await api(`/api/projects/${state.selectedProjectId}/chat`);
    state.analysisEntries = await api(`/api/projects/${state.selectedProjectId}/analysis`);
  }

  syncAnalysisTabSelection();

  render();
}

function render() {
  renderProjectList();
  els.projectTitle.textContent = state.selectedProject?.name ?? "プロジェクトを選択してください";
  renderSnapshotPicker();
  setActionButtonsState();
  els.pipelineMonitor.innerHTML = renderPipelineMonitor(state.selectedProject);
  els.chatMessages.innerHTML = renderChatMessages(state.messages);
  els.analysisViewer.innerHTML = renderAnalysis(
    state.selectedProject,
    state.analysisEntries,
    currentImprovementDraft(),
    currentAnalysisTab(),
  );
  bindAnalysisActions();
  els.eventLog.textContent = state.logs.slice(-40).join("\n");
}

function renderProjectList() {
  els.projectList.innerHTML = state.projects
    .map(
      (project) => `
        <article class="project-card ${project.id === state.selectedProjectId ? "is-active" : ""}" data-project-id="${project.id}">
          <strong>${escapeHtml(project.name)}</strong>
          <div class="project-meta">${escapeHtml(statusLabel(project.state.status))} / フェーズ ${project.state.currentPhase}</div>
          <div class="project-meta">${escapeHtml(project.idea.slice(0, 80))}</div>
        </article>
      `,
    )
    .join("");

  els.projectList.querySelectorAll("[data-project-id]").forEach((node) => {
    node.addEventListener("click", async () => {
      state.selectedProjectId = node.dataset.projectId;
      state.selectedSnapshotId = "";
      await refreshSelectedProject();
    });
  });
}

function renderSnapshotPicker() {
  const snapshots = state.liveProject?.snapshots ?? [];
  els.snapshotSelect.innerHTML = [
    '<option value="">最新版</option>',
    ...snapshots.map(
      (snapshot) =>
        `<option value="${escapeHtml(snapshot.id)}">${escapeHtml(formatSnapshotLabel(snapshot))}</option>`,
    ),
  ].join("");
  els.snapshotSelect.value = state.selectedSnapshotId;

  if (state.selectedProject?.viewingSnapshot) {
    const snapshot = state.selectedProject.viewingSnapshot;
    els.snapshotMeta.textContent = `保存版を表示中: ${snapshot.createdAt} / ${snapshot.reason}`;
  } else if (state.liveProject) {
    els.snapshotMeta.textContent = `最新版を表示中: 最終更新 ${state.liveProject.updatedAt}`;
  } else {
    els.snapshotMeta.textContent = "最新版を表示中";
  }
}

function setActionButtonsState() {
  const disabled = Boolean(state.selectedProject?.viewingSnapshot);
  [els.startProject, els.approveProject, els.retryProject, els.improveProject].forEach((button) => {
    button.disabled = disabled;
    button.title = disabled ? "保存済みバージョン表示中は操作できません。最新版に戻してください。" : "";
  });

  if (disabled || !state.selectedProject) {
    els.approveProject.textContent = "承認";
    return;
  }

  const { status, awaitingApproval } = state.selectedProject.state;
  els.approveProject.textContent = approveButtonLabel(status, awaitingApproval);
  if (!disabled) {
    els.approveProject.title = approveButtonTitle(status, awaitingApproval);
  }
}

function currentImprovementDraft() {
  if (!state.selectedProjectId) {
    return { selected: [], customNote: "" };
  }

  if (!state.improvementDrafts[state.selectedProjectId]) {
    state.improvementDrafts[state.selectedProjectId] = {
      selected: [],
      customNote: "",
    };
  }

  return state.improvementDrafts[state.selectedProjectId];
}

function currentAnalysisTab() {
  if (!state.selectedProjectId) {
    return "report";
  }

  if (!state.analysisTabs[state.selectedProjectId]) {
    state.analysisTabs[state.selectedProjectId] = "report";
  }

  return state.analysisTabs[state.selectedProjectId];
}

function syncAnalysisTabSelection() {
  if (!state.selectedProjectId || !state.selectedProject || state.selectedProject.viewingSnapshot) {
    return;
  }

  const project = state.selectedProject;
  const shouldFocusReport =
    project.state.currentPhase === 4 ||
    project.state.awaitingApproval === "analysis_complete" ||
    project.state.status === "completed";

  if (shouldFocusReport) {
    state.analysisTabs[state.selectedProjectId] = "report";
  }
}

function bindAnalysisActions() {
  els.analysisViewer.querySelectorAll("[data-analysis-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.selectedProjectId) {
        return;
      }
      state.analysisTabs[state.selectedProjectId] = button.dataset.analysisTab;
      render();
    });
  });

  els.analysisViewer.querySelectorAll("[data-improvement-index]").forEach((input) => {
    input.addEventListener("change", () => {
      const draft = currentImprovementDraft();
      const selected = new Set(draft.selected);
      if (input.checked) {
        selected.add(input.dataset.improvementIndex);
      } else {
        selected.delete(input.dataset.improvementIndex);
      }
      draft.selected = [...selected];
      render();
    });
  });

  const customNote = els.analysisViewer.querySelector("#improvement-custom-note");
  if (customNote) {
    customNote.addEventListener("input", () => {
      currentImprovementDraft().customNote = customNote.value;
    });
  }

  const applyButton = els.analysisViewer.querySelector("#apply-improvement-plan");
  if (applyButton) {
    applyButton.addEventListener("click", () => {
      void applyImprovementPlan();
    });
  }
}

function syncSnapshotSelection() {
  const snapshots = state.liveProject?.snapshots ?? [];
  if (state.selectedSnapshotId && !snapshots.some((snapshot) => snapshot.id === state.selectedSnapshotId)) {
    state.selectedSnapshotId = "";
  }
}

function renderSettings() {
  if (!state.settings) {
    return;
  }
  els.setupWizard.innerHTML = renderSetupWizard(state.settings);
}

async function actOnProject(action) {
  if (!state.selectedProjectId) {
    return;
  }
  await api(`/api/projects/${state.selectedProjectId}/${action}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  await refreshSelectedProject();
}

function openImprovementComposer() {
  const analysisTab = document.querySelector('[data-tab="analysis"]');
  if (!analysisTab) {
    return;
  }
  if (state.selectedProjectId) {
    state.analysisTabs[state.selectedProjectId] = "report";
    render();
  }
  analysisTab.click();
  const composer = document.querySelector("#improvement-composer");
  composer?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function applyImprovementPlan() {
  if (!state.selectedProjectId || !state.selectedProject || state.selectedProject.viewingSnapshot) {
    return;
  }

  const draft = currentImprovementDraft();
  const reportEntry = state.analysisEntries.find((entry) => entry.fileName === "report.json");
  const report = reportEntry ? safeParse(reportEntry.contents) : null;
  const proposals = report
    ? [
        ...asArray(report.next_improvement_proposals),
        ...asArray(report.analysis?.improvement_proposals),
      ]
    : [];

  const selectedTexts = draft.selected
    .map((proposalId) => {
      const index = Number(String(proposalId).replace("proposal-", ""));
      const proposal = asObject(proposals[index]);
      if (!proposal) {
        return "";
      }

      return expandProposalToConcreteInstruction(proposal);
    })
    .filter(Boolean);

  const customNote = draft.customNote.trim();
  if (selectedTexts.length === 0 && !customNote) {
    window.alert("改善案を1つ以上選ぶか、自分の指示を入力してください。");
    return;
  }

  const message = buildImprovementMessage(selectedTexts, customNote);

  await api(`/api/projects/${state.selectedProjectId}/improve`, {
    method: "POST",
    body: JSON.stringify({ feedback: message }),
  });

  state.logs.push("[improve] selected proposals applied");
  state.improvementDrafts[state.selectedProjectId] = { selected: [], customNote: "" };
  document.querySelector('[data-tab="pipeline"]')?.click();
  await refreshSelectedProject();
}

async function testMt5() {
  const payload = await api("/api/settings/test-mt5", {
    method: "POST",
    body: JSON.stringify({ mt5: readSettingsForm().mt5 }),
  });
  els.mt5Status.textContent = payload.ok ? "接続OK" : "未接続";
  state.logs.push(`[test-mt5] ${JSON.stringify(payload.details)}`);
  render();
}

async function testCodex() {
  const settings = readSettingsForm();
  const payload = await api("/api/settings/test-codex", {
    method: "POST",
    body: JSON.stringify({ command: settings.codex.command }),
  });
  els.codexStatus.textContent = payload.ok ? "接続OK" : "要確認";
  state.logs.push(`[test-codex] ${payload.message || payload.stdout || payload.stderr}`.trim());
  render();
}

async function saveSettings() {
  const settings = readSettingsForm();
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  state.settings = settings;
  els.modeLabel.textContent = modeLabel(settings.pipeline.mode);
  state.logs.push("[settings] saved");
  render();
}

function readSettingsForm() {
  const next = structuredClone(state.settings);
  document.querySelectorAll("[data-setting]").forEach((input) => {
    const path = input.dataset.setting.split(".");
    let target = next;
    while (path.length > 1) {
      target = target[path.shift()];
    }
    const finalKey = path.shift();
    target[finalKey] = /^\d+$/.test(input.value) ? Number(input.value) : input.value;
  });
  return next;
}

async function setSystemMode(mode) {
  await api("/api/system/mode", {
    method: "PUT",
    body: JSON.stringify({ mode }),
  });
  state.settings.pipeline.mode = mode;
  els.modeLabel.textContent = modeLabel(mode);
}

function initWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener("message", async (event) => {
    const { event: eventName, payload } = JSON.parse(event.data);
    state.logs.push(`[${eventName}] ${JSON.stringify(payload)}`);
    if (!state.selectedProjectId || payload.projectId === state.selectedProjectId) {
      await refreshProjects();
    } else {
      render();
    }
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatSnapshotLabel(snapshot) {
  return `${snapshot.createdAt} / 改善前 / ${snapshot.reason} / ${snapshot.status}`;
}

function approveButtonLabel(status, awaitingApproval) {
  if (status !== "waiting_approval") {
    return "承認";
  }

  switch (awaitingApproval) {
    case "spec_approved":
      return "仕様書を承認";
    case "optimization_complete":
      return "AI分析を開始";
    case "analysis_complete":
      return "分析結果を確定";
    default:
      return "承認";
  }
}

function approveButtonTitle(status, awaitingApproval) {
  if (status !== "waiting_approval") {
    return "";
  }

  switch (awaitingApproval) {
    case "spec_approved":
      return "仕様書を確定して、次の工程へ進みます。";
    case "optimization_complete":
      return "最適化結果を承認して、AI分析を開始します。";
    case "analysis_complete":
      return "AI分析結果を承認して、この実験を完了扱いにします。";
    default:
      return "";
  }
}

function safeParse(contents) {
  try {
    return JSON.parse(contents);
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function buildImprovementMessage(selectedTexts, customNote) {
  return [
    "前回の分析結果を踏まえて、spec.yaml を具体的に更新してください。",
    "今回は方向性の提案ではなく、仕様書の変更内容として反映することが目的です。",
    "既存 spec.yaml の内容を維持しつつ、下記の変更点を必ず spec.yaml に書き込んでください。",
    "",
    "必須ルール:",
    "- 変更がある項目は、spec.yaml の該当セクションに明示的に反映してください。",
    "- entry_logic, exit_logic, indicators, optimization_params の変更は文章だけでなく仕様値として書いてください。",
    "- 既存仕様から変更した箇所が分かるように、内容を具体化してください。",
    "",
    selectedTexts.length ? "反映すべき変更点:" : "",
    selectedTexts.join("\n\n"),
    customNote ? "" : "",
    customNote ? "追加の指示:" : "",
    customNote,
    "",
    "更新後の spec.yaml を保存し、その内容を確認できる状態にしてください。",
  ]
    .filter(Boolean)
    .join("\n");
}

function expandProposalToConcreteInstruction(proposal) {
  const title = String(proposal.title ?? "改善案");
  const action = String(proposal.action ?? "");
  const reason = String(proposal.reason ?? proposal.why ?? "");

  if (title.includes("逆張りの発動条件をもっと厳しくする")) {
    return [
      `- ${title}`,
      "  spec.yaml への必須反映:",
      "  - indicators の RSI period は 15 に変更する。",
      "  - entry_logic に、RSI クロス単独では入らず、反転確認が必要と明記する。",
      "  - 反転確認として、少なくとも『直近高安更新の失敗』または『ボリンジャーバンド外からの回帰』のどちらかを entry_logic に追加する。",
      "  - optimization_params の oversold_level は 18-22、overbought_level は 78-82 の狭い範囲へ変更する。",
      action ? `  元の改善案: ${action}` : "",
      reason ? `  理由: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (title.includes("レジームフィルターを入れてトレンド相場の逆張りを止める")) {
    return [
      `- ${title}`,
      "  spec.yaml への必須反映:",
      "  - indicators に H1 フィルター用の EMA または ADX を追加する。",
      "  - entry_logic に『強いトレンド中はエントリーしない』条件を追加する。",
      "  - どの条件でトレンドと判定するかを entry_logic または indicators に明記する。",
      "  - timeframe は M15 のままでも、H1 を参照する上位足フィルターを使うことを仕様に書く。",
      action ? `  元の改善案: ${action}` : "",
      reason ? `  理由: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (title.includes("TP を固定値最適化から構造改善へ切り替える")) {
    return [
      `- ${title}`,
      "  spec.yaml への必須反映:",
      "  - exit_logic に部分利確またはトレーリングの考え方を追加する。",
      "  - risk_management.take_profit を固定 ATR 倍率だけにせず、段階利確または条件付き利確の仕様へ変更する。",
      "  - optimization_params の atr_tp_multiplier は 1.3-2.1 付近の狭い範囲に見直す。",
      action ? `  元の改善案: ${action}` : "",
      reason ? `  理由: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (title.includes("max_holding_bars")) {
    return [
      `- ${title}`,
      "  spec.yaml への必須反映:",
      "  - exit_logic に、損失時は短く切る time stop と、含み益時は保有延長する条件分岐を追加する。",
      "  - optimization_params の max_holding_bars は、4 と 20 を比較しやすい形に整理する。",
      action ? `  元の改善案: ${action}` : "",
      reason ? `  理由: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (title.includes("最適化条件の不整合を先に修正する")) {
    return [
      `- ${title}`,
      "  spec.yaml への必須反映:",
      "  - optimization_params の start/stop/step を見直し、仕様外の値が出ない範囲に整理する。",
      "  - overbought_level, atr_sl_multiplier, atr_tp_multiplier の範囲を spec.yaml 上で明確にする。",
      action ? `  元の改善案: ${action}` : "",
      reason ? `  理由: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `- ${title}`,
    "  spec.yaml への必須反映:",
    action || "  具体的な変更内容を spec.yaml の各項目へ落とし込むこと。",
    reason ? `  理由: ${reason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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

function modeLabel(mode) {
  return mode === "autonomous" ? "自動" : "確認";
}

void bootstrap();
