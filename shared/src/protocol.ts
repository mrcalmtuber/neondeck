/**
 * Wire protocol shared between the browser frontend and the daemon.
 *
 * Transport: JSON over the WebSocket bridge (browser default ws://127.0.0.1:5000;
 * point at a remote NeonDeck node by setting VITE_DAEMON_URL). The daemon itself
 * binds the host/port from its own config (default 0.0.0.0:5000 for headless
 * production, e.g. a Raspberry Pi 5 — see daemon/src/config.ts).
 * Requests carry a client-generated `id`; the daemon echoes that `id` on every
 * response/stream chunk so the browser can correlate them. Pushed events use
 * the literal id "broadcast".
 *
 * v4: adds the multi-project hub model, inline AI (explain/fix), visual git
 * sync, and the live process dashboard. The agent + AI calls run INSIDE the
 * daemon (the API key lives in the daemon's env and never reaches the browser).
 *
 * v5: adds the visual npm package manager, the SQLite database explorer, the
 * agent Copilot/Autopilot mode toggle with per-tool approval, and zero-config
 * public tunnel sharing. All execution stays daemon-side.
 *
 * v6: adds central auth + multi-tenancy (the handshake carries a Firebase ID
 * token + userId), subscription tiers with per-user monthly token metering, and
 * a paywall signal. Pricing/token rules live in ./tiers.ts (re-exported below).
 */

export * from "./tiers.js";
import type { Tier, AgentEffort } from "./tiers.js";

/**
 * Default host the BROWSER dials. Daemon bind host is separate (config.host).
 *
 * Port is 5050 (not 5000) on purpose: macOS Monterey+ runs the AirPlay Receiver
 * (ControlCenter / AirTunes) on port 5000, which answers HTTP 403 and breaks the
 * WebSocket upgrade ("bad response from the server"). 5050 avoids that clash.
 */
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT = 5050;
export const DAEMON_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}`;

/** Preferred host gateway port; the daemon scans upward if it is taken. */
export const PROXY_PORT = 9000;

/** Bump when the message shape changes; the daemon refuses mismatched clients.
 *  (hello.githubToken is an optional, additive field — old daemons ignore it, so
 *  no bump is needed and a running daemon never gets force-rejected.) */
export const PROTOCOL_VERSION = 6;

export type RuntimeMode = "DOCKER" | "LOCAL_NODE" | "BROWSER";

export type Blueprint = "react-vite" | "python" | "vanilla" | "blank";

/** Agent autonomy mode (Feature 3). */
export type AgentMode = "copilot" | "autopilot";

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

export interface FileNode {
  name: string;
  path: string; // workspace-relative POSIX path
  type: "file" | "dir";
  children?: FileNode[];
}

export interface ProjectInfo {
  name: string;
  lastModifiedMs: number;
  entryCount: number;
}

export interface GitCommit {
  hash: string;
  author: string;
  relativeDate: string;
  subject: string;
}

export interface ProcessInfo {
  id: string;
  label: string;
  command: string;
  pid: number | null;
  port: number | null;
  runtime: RuntimeMode;
  ramKB: number | null;
  startedAtMs: number;
}

// ---- Feature 2: SQLite database explorer ----

export interface DbColumn {
  name: string;
  type: string;
  pk: boolean;
}

export interface DbTableMeta {
  name: string;
  rowCount: number;
}

/** A row, plus the hidden sqlite rowid we use as a stable edit/delete key. */
export interface DbRow {
  _rowid: number;
  [column: string]: unknown;
}

/** Tunnel share state (Feature 4). */
export type TunnelState = "starting" | "open" | "closed" | "error";

// ---------------------------------------------------------------------------
// Browser -> Daemon
// ---------------------------------------------------------------------------

export interface HelloRequest {
  type: "hello";
  id: string;
  protocolVersion: number;
  /** Firebase ID token (JWT). Verified daemon-side before any project op. */
  token?: string;
  /** The authenticated user id, echoed for multi-tenant file isolation. */
  userId?: string;
  /** Optional GitHub OAuth access token (held in the browser; re-sent each
   *  connect). When present the daemon syncs this user's projects to their own
   *  GitHub so they survive a diskless redeploy. */
  githubToken?: string;
}

/** Per-user subscription + metering snapshot pushed to the browser. */
export interface UsageSnapshot {
  tier: Tier;
  tokensUsed: number;
  tokensLimit: number;
  /** Calendar period this usage belongs to, e.g. "2026-06". */
  period: string;
  /** True once the monthly pool is exhausted (agent pipeline paused). */
  limitReached: boolean;
}

export interface ListProjectsRequest {
  type: "list_projects";
  id: string;
}
export interface CreateProjectRequest {
  type: "create_project";
  id: string;
  name: string;
  blueprint: Blueprint;
}
export interface OpenProjectRequest {
  type: "open_project";
  id: string;
  name: string;
}

export interface ListTreeRequest {
  type: "list_tree";
  id: string;
}
export interface ReadFileRequest {
  type: "read_file";
  id: string;
  filePath: string;
}

/** Project-wide text search across the open workspace's files. */
export interface SearchFilesRequest {
  type: "search_files";
  id: string;
  query: string;
  caseSensitive?: boolean;
}

export interface ManualCreateRequest {
  type: "manual_create";
  id: string;
  filePath: string;
  kind: "file" | "dir";
}
export interface ManualUpdateRequest {
  type: "manual_update";
  id: string;
  filePath: string;
  content: string;
}
export interface ManualDeleteRequest {
  type: "manual_delete";
  id: string;
  filePath: string;
}

export interface RunCommandRequest {
  type: "run_command";
  id: string;
  command: string;
}
export interface StartContainerRequest {
  type: "start_container";
  id: string;
  image: string;
  startCommand: string;
  appPort: number;
}

export interface SetRuntimeRequest {
  type: "set_runtime";
  id: string;
  mode: RuntimeMode | "auto";
}

export interface AgentPromptRequest {
  type: "agent_prompt";
  id: string;
  prompt: string;
  /** Copilot gates every structural tool behind approval; autopilot runs free. */
  mode: AgentMode;
  /** Reasoning effort the user selected (daemon clamps it to the tier's ceiling). */
  effort?: AgentEffort;
}
export interface StopAgentRequest {
  type: "stop_agent";
  id: string;
}

// ---- Admin ops (only honored when the session's email is in ADMIN_EMAILS;
// the daemon rejects these from non-admins). ----
export interface AdminSubscribeRequest {
  type: "admin_subscribe";
  id: string;
}
export interface AdminCancelAgentRequest {
  type: "admin_cancel_agent";
  id: string;
  /** Target session to cancel the agent on (from AdminSessionInfo.sessionId). */
  sessionId: string;
}
export interface AdminSetMaintenanceRequest {
  type: "admin_set_maintenance";
  id: string;
  on: boolean;
  message: string;
}
/** Admin: change ANY user's subscription tier (0=Free,1=Pro,2=Max), by uid — works
 *  for offline users too (applied to the durable ledger). */
export interface AdminSetTierRequest {
  type: "admin_set_tier";
  id: string;
  userId: string;
  tier: number;
}
/** Admin: set ANY user's monthly token usage to an absolute value (e.g. a text-input
 *  number, or the limit to "max out"/hit their limit). */
export interface AdminSetUsageRequest {
  type: "admin_set_usage";
  id: string;
  userId: string;
  tokensUsed: number;
}
/** Admin: set (or clear) a per-user custom monthly token LIMIT override, independent
 *  of their tier. `limit: null` clears it (back to the tier default). */
export interface AdminSetLimitRequest {
  type: "admin_set_limit";
  id: string;
  userId: string;
  limit: number | null;
}
/** Admin: look up ANY user by email (online or not) to view/edit their plan + usage. */
export interface AdminLookupUserRequest {
  type: "admin_lookup_user";
  id: string;
  email: string;
}
/** Admin: list every user active within the last `sinceMs` window (default 4 days). */
export interface AdminListUsersRequest {
  type: "admin_list_users";
  id: string;
  sinceMs?: number;
}
/** Admin: suspend / un-suspend ANY user (durable). A suspended user is locked out
 *  with a "you have been suspended" screen + the optional custom message. */
export interface AdminSetSuspendedRequest {
  type: "admin_set_suspended";
  id: string;
  userId: string;
  suspended: boolean;
  message: string;
}

// Feature A — inline AI
export interface AiExplainRequest {
  type: "ai_explain";
  id: string;
  code: string;
  filePath?: string;
}
export interface AiFixRequest {
  type: "ai_fix";
  id: string;
  filePath: string;
  code: string;
}

// Feature B — visual git
export interface GitLogRequest {
  type: "git_log";
  id: string;
}
export interface GitPublishRequest {
  type: "git_publish";
  id: string;
  message: string;
  remoteUrl?: string;
}

// Feature C — process dashboard
export interface ListProcessesRequest {
  type: "list_processes";
  id: string;
}
export interface KillProcessRequest {
  type: "kill_process";
  id: string;
  procId: string;
}

// Feature 1 — visual npm package manager
export interface InstallPackageRequest {
  type: "install_package";
  id: string;
  packageName: string;
  dev?: boolean;
}

// Feature 2 — SQLite database explorer
export interface DbOpenRequest {
  type: "db_open";
  id: string;
}
export interface DbReadRequest {
  type: "db_read";
  id: string;
  table: string;
}
export interface DbInsertRequest {
  type: "db_insert";
  id: string;
  table: string;
  values: Record<string, unknown>;
}
export interface DbUpdateRequest {
  type: "db_update";
  id: string;
  table: string;
  rowid: number;
  column: string;
  value: unknown;
}
export interface DbDeleteRequest {
  type: "db_delete";
  id: string;
  table: string;
  rowid: number;
}
export interface DbCreateTableRequest {
  type: "db_create_table";
  id: string;
  table: string;
  columns: string[]; // simple column names; created as TEXT + an auto id PK
}

// Feature 3 — agent autonomy mode + per-tool approval
export interface ApproveToolRequest {
  type: "approve_tool";
  id: string; // the agent prompt id this approval belongs to
  approve: boolean;
}

// Feature 4 — zero-config public tunnel
export interface StartTunnelRequest {
  type: "start_tunnel";
  id: string;
}
export interface StopTunnelRequest {
  type: "stop_tunnel";
  id: string;
}

export type ClientMessage =
  | HelloRequest
  | ListProjectsRequest
  | CreateProjectRequest
  | OpenProjectRequest
  | ListTreeRequest
  | ReadFileRequest
  | SearchFilesRequest
  | ManualCreateRequest
  | ManualUpdateRequest
  | ManualDeleteRequest
  | RunCommandRequest
  | StartContainerRequest
  | SetRuntimeRequest
  | AgentPromptRequest
  | StopAgentRequest
  | AiExplainRequest
  | AiFixRequest
  | GitLogRequest
  | GitPublishRequest
  | ListProcessesRequest
  | KillProcessRequest
  | InstallPackageRequest
  | DbOpenRequest
  | DbReadRequest
  | DbInsertRequest
  | DbUpdateRequest
  | DbDeleteRequest
  | DbCreateTableRequest
  | ApproveToolRequest
  | StartTunnelRequest
  | StopTunnelRequest
  | AdminSubscribeRequest
  | AdminCancelAgentRequest
  | AdminSetMaintenanceRequest
  | AdminSetTierRequest
  | AdminSetUsageRequest
  | AdminSetLimitRequest
  | AdminLookupUserRequest
  | AdminListUsersRequest
  | AdminSetSuspendedRequest;

// ---------------------------------------------------------------------------
// Daemon -> Browser
// ---------------------------------------------------------------------------

/** Maintenance lockout state. When `on`, non-admins are fully locked out. */
export interface MaintenanceState {
  on: boolean;
  message: string;
}

/** Default copy shown to locked-out users when no custom message is set. */
export const DEFAULT_MAINTENANCE_MESSAGE =
  "System Under Maintenance. We are performing scheduled updates to improve our service. All systems are temporarily unavailable. We expect to be back shortly. Thank you for your patience!";

/** A live session row for the admin dashboard. */
export interface AdminSessionInfo {
  sessionId: string;
  /** The authenticated uid (admin-only) — keys tier/usage/limit edits. */
  userId: string | null;
  email: string | null;
  authMode: "firebase" | "dev";
  project: string | null;
  agentRunning: boolean;
  agentStep: number | null;
  procCount: number;
  previewActive: boolean;
  connectedAtMs: number;
  /** Subscription tier (0=Free,1=Pro,2=Max) + this month's token usage, so the
   *  admin can view plans and remotely adjust tier / usage. */
  tier: number;
  tokensUsed: number;
  tokensLimit: number;
  /** Custom limit override in effect (null = using the tier default). */
  limitOverride: number | null;
}

/** A user record for the admin "manage any user" lookup (online or offline). */
export interface AdminUserInfo {
  userId: string;
  email: string | null;
  tier: number;
  tokensUsed: number;
  tokensLimit: number;
  limitOverride: number | null;
  online: boolean;
  /** Suspension state + the custom message shown to the locked-out user. */
  suspended: boolean;
  suspendMessage: string;
}

export interface HelloResponse {
  type: "hello_ok";
  id: string;
  protocolVersion: number;
  agentReady: boolean;
  model: string;
  runtimeMode: RuntimeMode;
  dockerAvailable: boolean;
  proxyPort: number;
  projectsRootName: string;
  // v6 — auth + billing context for the signed-in user.
  userId: string;
  authMode: "firebase" | "dev";
  usage: UsageSnapshot;
  /** Whether the daemon has Stripe configured (gates the checkout buttons). */
  billingEnabled: boolean;
  /** Whether this user is an admin (email in ADMIN_EMAILS) — gates the admin dashboard. */
  isAdmin: boolean;
  /** Current maintenance state (admins are exempt; non-admins get a full lockout). */
  maintenance: MaintenanceState;
  /** Set when this connection reattached to an agent run that survived a brief drop,
   *  so the client can restore the live run's UI (project + chat + stream). */
  activeRun?: { promptId: string; project: string } | null;
  /** Per-user suspension: when true this user is locked out with a suspended screen. */
  suspended: boolean;
  suspendMessage: string;
}

export interface ProjectsResponse {
  type: "projects";
  id: string;
  projects: ProjectInfo[];
}
export interface ProjectCreatedResponse {
  type: "project_created";
  id: string;
  project: ProjectInfo;
}
export interface ProjectOpenedResponse {
  type: "project_opened";
  id: string;
  workspaceName: string;
  root: FileNode;
}

export interface RuntimeChangedMessage {
  type: "runtime_changed";
  id: string;
  runtimeMode: RuntimeMode;
  dockerAvailable: boolean;
}

export interface TreeResponse {
  type: "tree";
  id: string;
  root: FileNode;
}
export interface WorkspaceChangedMessage {
  type: "workspace_changed";
  id: "broadcast";
  root: FileNode;
}
export interface FileContentResponse {
  type: "file_content";
  id: string;
  filePath: string;
  content: string;
}

/** A single project-search hit. `line` is 1-based; `col` is the match offset. */
export interface SearchMatch {
  path: string;
  line: number;
  col: number;
  preview: string;
}
export interface SearchResultsResponse {
  type: "search_results";
  id: string;
  matches: SearchMatch[];
  truncated: boolean;
}
export interface ManualOkResponse {
  type: "manual_ok";
  id: string;
  op: "create" | "update" | "delete";
  filePath: string;
}

export interface TerminalOutputMessage {
  type: "terminal_output";
  id: string;
  stream: "stdout" | "stderr";
  data: string;
}
export interface CommandExitMessage {
  type: "command_exit";
  id: string;
  exitCode: number | null;
}
export interface ContainerStartedMessage {
  type: "container_started";
  id: string;
  proxyUrl: string;
  slot: string;
}
export interface PreviewReloadMessage {
  type: "preview_reload";
  id: "broadcast";
  slot: string;
}

export interface AgentDeltaMessage {
  type: "agent_delta";
  id: string;
  text: string;
}
export interface AgentToolMessage {
  type: "agent_tool";
  id: string;
  toolName: string;
  summary: string;
}
export interface AgentStatusMessage {
  type: "agent_status";
  id: string;
  status: string;
}
export interface AgentDoneMessage {
  type: "agent_done";
  id: string;
  reason: "completed" | "stopped" | "max_steps";
}

// Feature A results
export interface AiDeltaMessage {
  type: "ai_delta";
  id: string;
  text: string;
}
export interface AiDoneMessage {
  type: "ai_done";
  id: string;
}
export interface AiFixResultMessage {
  type: "ai_fix_result";
  id: string;
  filePath: string;
  original: string;
  fixed: string;
}

// Feature B results
export interface GitHistoryMessage {
  type: "git_history";
  id: string;
  commits: GitCommit[];
  isRepo: boolean;
}
export interface GitResultMessage {
  type: "git_result";
  id: string;
  ok: boolean;
  message: string;
}

// Feature C results
export interface ProcessesMessage {
  type: "processes";
  id: string; // request id, or "broadcast"
  processes: ProcessInfo[];
}

// Feature 1 — package install lifecycle (output also streams via terminal_output)
export interface PackageResultMessage {
  type: "package_result";
  id: string;
  ok: boolean;
  packageName: string;
  message: string;
}

// Feature 2 — database explorer
export interface DbSchemaMessage {
  type: "db_schema";
  id: string;
  dbPath: string; // workspace-relative, e.g. "storage.db"
  tables: DbTableMeta[];
}
export interface DbRowsMessage {
  type: "db_rows";
  id: string;
  table: string;
  columns: DbColumn[];
  rows: DbRow[];
}

// Feature 3 — agent asks the human to approve a gated tool call (copilot mode)
export interface AgentApprovalMessage {
  type: "agent_approval";
  id: string; // the agent prompt id
  toolName: string;
  summary: string;
  detail: string; // file contents / command preview
}

// Feature 4 — tunnel status
export interface TunnelStatusMessage {
  type: "tunnel_status";
  id: string;
  state: TunnelState;
  url?: string;
  message?: string;
}

// v6 — live token-meter snapshot (pushed after each metered agent/AI call).
export interface UsageUpdateMessage {
  type: "usage_update";
  id: string; // request id or "broadcast"
  usage: UsageSnapshot;
}

// v6 — the monthly pool is exhausted: pause the pipeline and show the paywall.
export interface PaywallMessage {
  type: "paywall";
  id: string;
  usage: UsageSnapshot;
  message: string;
}

export interface ErrorMessage {
  type: "error";
  id: string;
  message: string;
}

// ---- Admin ops + maintenance (daemon -> browser) ----
export interface AdminStateMessage {
  type: "admin_state";
  id: string; // request id, or "broadcast"
  sessions: AdminSessionInfo[];
  maintenance: MaintenanceState;
}
export interface MaintenanceChangedMessage {
  type: "maintenance_changed";
  id: string; // "broadcast"
  maintenance: MaintenanceState;
}
/** Pushed to a user's sessions when an admin suspends / un-suspends them (live). */
export interface SuspensionChangedMessage {
  type: "suspension_changed";
  id: string; // "broadcast"
  suspended: boolean;
  message: string;
}
/** Reply to admin_lookup_user — the matched user (or null if no such email). */
export interface AdminUserMessage {
  type: "admin_user";
  id: string;
  user: AdminUserInfo | null;
}
/** Reply to admin_list_users — every user active in the requested window. */
export interface AdminUsersMessage {
  type: "admin_users";
  id: string;
  users: AdminUserInfo[];
}
/** A lightweight toast pushed to a user (e.g. "an admin stopped your agent"). */
export interface NoticeMessage {
  type: "notice";
  id: string;
  level: "info" | "warn";
  text: string;
}

export type ServerMessage =
  | HelloResponse
  | ProjectsResponse
  | ProjectCreatedResponse
  | ProjectOpenedResponse
  | RuntimeChangedMessage
  | TreeResponse
  | WorkspaceChangedMessage
  | FileContentResponse
  | SearchResultsResponse
  | ManualOkResponse
  | TerminalOutputMessage
  | CommandExitMessage
  | ContainerStartedMessage
  | PreviewReloadMessage
  | AgentDeltaMessage
  | AgentToolMessage
  | AgentStatusMessage
  | AgentDoneMessage
  | AiDeltaMessage
  | AiDoneMessage
  | AiFixResultMessage
  | GitHistoryMessage
  | GitResultMessage
  | ProcessesMessage
  | PackageResultMessage
  | DbSchemaMessage
  | DbRowsMessage
  | AgentApprovalMessage
  | TunnelStatusMessage
  | UsageUpdateMessage
  | PaywallMessage
  | ErrorMessage
  | AdminStateMessage
  | AdminUserMessage
  | AdminUsersMessage
  | MaintenanceChangedMessage
  | SuspensionChangedMessage
  | NoticeMessage;
