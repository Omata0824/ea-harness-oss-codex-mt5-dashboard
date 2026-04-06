import { renderAnalysis } from "./analysis-viewer.js";
import { renderChatMessages } from "./chat.js";
import { renderPipelineMonitor } from "./pipeline-monitor.js";
import { renderSetupWizard } from "./setup-wizard.js";

const state = {
  projects: [],
  selectedProjectId: null,
  selectedProject: null,
  messages: [],
  analysisEntries: [],
  settings: null,
  logs: [],
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
document.querySelector("#improve-project").addEventListener("click", () => actOnProject("improve"));

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
    state.selectedProject = null;
    state.messages = [];
    state.analysisEntries = [];
    render();
    return;
  }

  state.selectedProject = await api(`/api/projects/${state.selectedProjectId}`);
  state.messages = await api(`/api/projects/${state.selectedProjectId}/chat`);
  state.analysisEntries = await api(`/api/projects/${state.selectedProjectId}/analysis`);
  render();
}

function render() {
  renderProjectList();
  els.projectTitle.textContent = state.selectedProject?.name ?? "プロジェクトを選択してください";
  els.pipelineMonitor.innerHTML = renderPipelineMonitor(state.selectedProject);
  els.chatMessages.innerHTML = renderChatMessages(state.messages);
  els.analysisViewer.innerHTML = renderAnalysis(state.selectedProject, state.analysisEntries);
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
      await refreshSelectedProject();
    });
  });
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
  els.codexStatus.textContent = payload.ok ? "接続OK" : "エラー";
  state.logs.push(`[test-codex] ${payload.stdout || payload.stderr}`.trim());
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
