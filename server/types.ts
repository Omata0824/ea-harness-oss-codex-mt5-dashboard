export type PipelineMode = "confirm" | "autonomous";

export type ProjectStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "error"
  | "completed"
  | "stopped";

export type ApprovalPoint =
  | "spec_approved"
  | "optimization_complete"
  | "analysis_complete";

export interface EnvironmentConfig {
  mt5: {
    terminal_path: string;
    metaeditor_path: string;
    data_folder: string;
    experts_subfolder: string;
    tester_subfolder: string;
  };
  codex: {
    command: string;
    approval_mode: string;
    max_retry: number;
    timeout_seconds: number;
  };
  pipeline: {
    mode: PipelineMode;
    confirm_points: ApprovalPoint[];
    compile_max_retry: number;
  };
  server: {
    port: number;
    host: string;
  };
}

export interface PhaseResult {
  phase: 0 | 1 | 2 | 3 | 4;
  startedAt: string;
  completedAt: string;
  success: boolean;
  artifacts: string[];
  error?: string;
}

export interface PipelineState {
  projectId: string;
  currentPhase: 0 | 1 | 2 | 3 | 4;
  status: ProjectStatus;
  mode: PipelineMode;
  phaseHistory: PhaseResult[];
  iteration: number;
  retryCount: number;
  awaitingApproval?: ApprovalPoint;
  lastError?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  idea: string;
  createdAt: string;
  updatedAt: string;
  state: PipelineState;
}

export interface ProjectSnapshot {
  id: string;
  createdAt: string;
  reason: string;
  iteration: number;
  phase: number;
  status: ProjectStatus;
  path: string;
}

export interface ProjectSnapshotView {
  snapshot: ProjectSnapshot;
  project: ProjectRecord;
  spec: string | null;
  analysisEntries: Array<{
    fileName: string;
    contents: string;
  }>;
  messages: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  phase: 0 | 1 | 2 | 3 | 4;
  content: string;
  createdAt: string;
}

export interface CodexRequest {
  prompt: string;
  writableFiles: string[];
  readOnlyFiles: string[];
  workDir: string;
  timeoutMs: number;
  command: string;
  approvalMode: string;
}

export interface CodexResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  changedFiles: string[];
}

export interface CompileResult {
  success: boolean;
  logPath: string;
  errors: string[];
  stdout: string;
  stderr: string;
}

export interface TerminalRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface PhaseRunOutcome {
  success: boolean;
  artifacts: string[];
  error?: string;
  waitingForInput?: boolean;
  message?: string;
}
