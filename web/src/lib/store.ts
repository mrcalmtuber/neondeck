import { create } from "zustand";
import type {
  FileNode,
  RuntimeMode,
  ProjectInfo,
  ProcessInfo,
  GitCommit,
  AgentMode,
  AgentEffort,
  TunnelState,
  Tier,
  UsageSnapshot,
  AdminSessionInfo,
  MaintenanceState,
} from "@ide/shared";
import { TIERS } from "@ide/shared";
import type { AuthSession } from "./firebaseClient";
import { currentPeriod } from "./mockSession";
import { loadChat, clearChat } from "./chatHistory";

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

export type ConnState = "disconnected" | "connecting" | "connected" | "reconnecting";
/** The daemon is the only transport. (An in-tab VFS "browser mode" was removed —
 *  it kept leaking back in on errors and stranding users on a stale workspace.) */
export type Transport = "daemon";
/**
 * Top-level surface:
 *   "dashboard" — Replit-style home portal (sidebar + giant prompt + templates),
 *                 the default landing for both daemon and in-browser sessions
 *   "hub"       — legacy daemon project hub (kept as a fallback route)
 *   "ide"       — the single-view workspace once a project is active
 */
export type View = "dashboard" | "hub" | "ide" | "settings" | "admin";
/** Center workspace view: live preview or the code editor (overlays preview). */
/** Which single pane is shown on a phone (the 3-column IDE collapses to one). */
export type MobilePane = "agent" | "center" | "files";

export interface ErrorBanner {
  message: string;
  line?: string;
}

/** A tool call parked awaiting human approval in Copilot mode (Feature 3). */
export interface PendingApproval {
  promptId: string;
  toolName: string;
  summary: string;
  detail: string;
}

/** Public tunnel UI state (Feature 4). */
export interface TunnelUi {
  state: TunnelState | "idle";
  url?: string;
  message?: string;
}

export const THEMES = ["midnight", "coffee", "dracula", "contrast"] as const;
export type Theme = (typeof THEMES)[number];

export interface HelloInfoState {
  agentReady: boolean;
  model: string;
  runtimeMode: RuntimeMode;
  dockerAvailable: boolean;
  proxyPort: number;
  projectsRootName: string;
  userId: string;
  authMode: "firebase" | "dev";
  usage: UsageSnapshot;
  billingEnabled: boolean;
  isAdmin: boolean;
  maintenance: MaintenanceState;
  suspended: boolean;
  suspendMessage: string;
}

interface AppState {
  // ---- connection / transport / view ----
  conn: ConnState;
  transport: Transport;
  view: View;
  agentReady: boolean;
  model: string;
  runtimeMode: RuntimeMode;
  dockerAvailable: boolean;
  proxyPort: number;
  projectsRootName: string;
  setConn: (c: ConnState) => void;
  setHello: (info: HelloInfoState) => void;
  setTransport: (t: Transport) => void;
  setView: (v: View) => void;
  setRuntimeMode: (m: RuntimeMode, dockerAvailable?: boolean) => void;

  // ---- auth + billing (v6) ----
  authReady: boolean;
  setAuthReady: (r: boolean) => void;
  session: AuthSession | null;
  setSession: (s: AuthSession | null) => void;
  authMode: "firebase" | "dev";
  userId: string | null;
  usage: UsageSnapshot | null;
  billingEnabled: boolean;
  setUsage: (u: UsageSnapshot) => void;
  /** Why the last daemon handshake failed (null while connected/never tried). */
  connError: string | null;
  setConnError: (e: string | null) => void;
  /** Bumped to (re)trigger the daemon-connect effect WITHOUT depending on `conn`
   *  (so setting `conn` to "connecting" can't re-fire + cancel its own attempt). */
  connectNonce: number;
  /** Ask the app to (re)attempt the daemon handshake: resets conn + bumps nonce. */
  requestConnect: () => void;
  paywall: { usage: UsageSnapshot; message: string } | null;
  setPaywall: (p: { usage: UsageSnapshot; message: string } | null) => void;

  // ---- admin ops + maintenance ----
  isAdmin: boolean;
  /** MAINTENANCE (temporary — remove later): current lockout state. */
  maintenance: MaintenanceState;
  setMaintenance: (m: MaintenanceState) => void;
  /** Per-user suspension (this signed-in user). When true, show the suspended screen. */
  suspended: boolean;
  suspendMessage: string;
  setSuspension: (suspended: boolean, message: string) => void;
  /** Live session list for the admin dashboard (from admin_state pushes). */
  adminSessions: AdminSessionInfo[];
  setAdminSessions: (s: AdminSessionInfo[]) => void;
  /** Transient toast (e.g. "an admin stopped your agent"). */
  notice: { level: "info" | "warn"; text: string } | null;
  setNotice: (n: { level: "info" | "warn"; text: string } | null) => void;
  /** Celebratory gift modal (admin gratuity upgrade). */
  gift: { title: string; message: string; tier: number } | null;
  setGift: (g: { title: string; message: string; tier: number } | null) => void;

  /** Current tier, derived from the latest usage snapshot. */
  tier: () => Tier;
  /** Local billing simulation: instantly grant a paid tier (no Stripe). */
  simulateUpgrade: (tier: Tier) => void;

  // ---- local UI overlays (NeonDeck) ----
  /** Subscription / "Deploy to Web" paywall modal. */
  subscriptionModalOpen: boolean;
  setSubscriptionModalOpen: (v: boolean) => void;
  /** Sliding "NeonDeck Template Hub" overlay (Home button). */
  templateHubOpen: boolean;
  setTemplateHubOpen: (v: boolean) => void;

  // ---- hub / projects ----
  projects: ProjectInfo[];
  setProjects: (p: ProjectInfo[]) => void;
  /** Bumped whenever a project is created/opened — drives the Projects tab refresh. */
  projectsVersion: number;
  bumpProjects: () => void;
  activeProject: string | null;
  setActiveProject: (name: string | null) => void;

  // ---- file tree / editor ----
  tree: FileNode | null;
  setTree: (t: FileNode) => void;
  selectedPath: string | null;
  setSelected: (p: string | null) => void;
  openFile: string | null;
  fileContent: string;
  dirty: boolean;
  setOpenFile: (path: string, content: string) => void;
  setFileContent: (content: string) => void;
  markSaved: () => void;
  /** Line (1-based) the editor should scroll to once, e.g. from a search hit. */
  gotoLine: number | null;
  setGotoLine: (n: number | null) => void;

  // ---- live view ----
  previewUrl: string | null;
  previewSlot: string | null;
  setPreview: (url: string | null, slot: string | null) => void;

  // ---- logs / error banner ----
  errorBanner: ErrorBanner | null;
  setErrorBanner: (b: ErrorBanner | null) => void;

  // ---- processes (Feature C) ----
  processes: ProcessInfo[];
  setProcesses: (p: ProcessInfo[]) => void;

  // ---- git (Feature B) ----
  gitHistory: { isRepo: boolean; commits: GitCommit[] };
  setGitHistory: (h: { isRepo: boolean; commits: GitCommit[] }) => void;

  // ---- theme (Feature D) ----
  theme: Theme;
  setTheme: (t: Theme) => void;

  // ---- right file-tree drawer ----
  /** Whether the collapsible right-side file-tree column is open. */
  fileDrawerOpen: boolean;
  setFileDrawerOpen: (v: boolean) => void;
  /** Phone-only: which single pane is visible (the 3 columns collapse to one). */
  mobilePane: MobilePane;
  setMobilePane: (p: MobilePane) => void;
  /** Onboarding tour overlay — auto-shown the first time you open a project. */
  tourOpen: boolean;
  setTourOpen: (v: boolean) => void;

  // ---- agent autonomy mode + approval (Feature 3) ----
  agentMode: AgentMode;
  setAgentMode: (m: AgentMode) => void;
  /** User-selected reasoning effort for the agent (null ⇒ use the tier default). */
  agentEffort: AgentEffort | null;
  setAgentEffort: (e: AgentEffort) => void;
  pendingApproval: PendingApproval | null;
  setPendingApproval: (p: PendingApproval | null) => void;

  // ---- tunnel share (Feature 4) ----
  tunnel: TunnelUi;
  setTunnel: (t: TunnelUi) => void;

  // ---- agent ----
  messages: ChatMessage[];
  addMessage: (m: ChatMessage) => void;
  appendToLast: (delta: string) => void;
  agentRunning: boolean;
  agentStatus: string;
  setAgentRunning: (running: boolean, status?: string) => void;
  setAgentStatus: (status: string) => void;
  resetChat: () => void;
  /** Load a project's persisted chat into the store (on project open). */
  loadChatForProject: (project: string) => void;
  /** Empty the active project's chat AND forget its saved history. */
  clearActiveChat: () => void;
}

const THEME_KEY = "ide.theme";
const savedTheme = (localStorage.getItem(THEME_KEY) as Theme) || "midnight";


export const useStore = create<AppState>((set, get) => ({
  conn: "disconnected",
  transport: "daemon",
  view: "dashboard",
  agentReady: false,
  model: "",
  runtimeMode: "LOCAL_NODE",
  dockerAvailable: false,
  proxyPort: 9000,
  projectsRootName: "",
  setConn: (conn) => set({ conn }),
  setHello: (info) =>
    set({
      ...info,
      usage: info.usage,
      authMode: info.authMode,
      userId: info.userId,
      billingEnabled: info.billingEnabled,
      connError: null, // a successful handshake clears any prior failure
    }),
  setTransport: (transport) => set({ transport }),
  setView: (view) => set({ view }),
  setRuntimeMode: (runtimeMode, dockerAvailable) =>
    set((s) => ({ runtimeMode, dockerAvailable: dockerAvailable ?? s.dockerAvailable })),

  authReady: false,
  setAuthReady: (authReady) => set({ authReady }),
  session: null,
  setSession: (session) => set({ session }),
  authMode: "dev",
  userId: null,
  usage: null,
  // Global override: billing is always treated as configured (a mock Stripe
  // instance backs it) so an unconfigured billing state never blocks the IDE.
  billingEnabled: true,
  setUsage: (usage) => set({ usage }),
  connError: null,
  setConnError: (connError) => set({ connError }),
  connectNonce: 0,
  requestConnect: () =>
    set((s) => ({ connectNonce: s.connectNonce + 1, conn: "disconnected", connError: null })),
  paywall: null,
  setPaywall: (paywall) => set({ paywall }),

  isAdmin: false,
  maintenance: { on: false, message: "" },
  setMaintenance: (maintenance) => set({ maintenance }),
  suspended: false,
  suspendMessage: "",
  setSuspension: (suspended, suspendMessage) => set({ suspended, suspendMessage }),
  adminSessions: [],
  setAdminSessions: (adminSessions) => set({ adminSessions }),
  notice: null,
  setNotice: (notice) => set({ notice }),
  gift: null,
  setGift: (gift) => set({ gift }),

  tier: () => (get().usage?.tier ?? 0) as Tier,

  simulateUpgrade: (tier) =>
    set((s) => ({
      usage: {
        tier,
        tokensUsed: s.usage?.tokensUsed ?? 0,
        tokensLimit: TIERS[tier].tokenLimit,
        period: s.usage?.period ?? currentPeriod(),
        limitReached: false,
      },
    })),

  subscriptionModalOpen: false,
  setSubscriptionModalOpen: (subscriptionModalOpen) => set({ subscriptionModalOpen }),
  templateHubOpen: false,
  setTemplateHubOpen: (templateHubOpen) => set({ templateHubOpen }),

  projects: [],
  setProjects: (projects) => set({ projects }),
  projectsVersion: 0,
  bumpProjects: () => set((s) => ({ projectsVersion: s.projectsVersion + 1 })),
  activeProject: null,
  setActiveProject: (activeProject) => set({ activeProject }),

  tree: null,
  setTree: (tree) => set({ tree }),
  selectedPath: null,
  setSelected: (selectedPath) => set({ selectedPath }),
  openFile: null,
  fileContent: "",
  dirty: false,
  setOpenFile: (openFile, fileContent) => set({ openFile, fileContent, dirty: false }),
  setFileContent: (fileContent) => set({ fileContent, dirty: true }),
  markSaved: () => set({ dirty: false }),
  gotoLine: null,
  setGotoLine: (gotoLine) => set({ gotoLine }),

  previewUrl: null,
  previewSlot: null,
  setPreview: (previewUrl, previewSlot) => set({ previewUrl, previewSlot }),

  errorBanner: null,
  setErrorBanner: (errorBanner) => set({ errorBanner }),

  processes: [],
  setProcesses: (processes) => set({ processes }),

  gitHistory: { isRepo: false, commits: [] },
  setGitHistory: (gitHistory) => set({ gitHistory }),

  theme: savedTheme,
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },

  fileDrawerOpen: false,
  setFileDrawerOpen: (fileDrawerOpen) => set({ fileDrawerOpen }),
  mobilePane: "agent",
  setMobilePane: (mobilePane) => set({ mobilePane }),
  tourOpen: false,
  setTourOpen: (tourOpen) => set({ tourOpen }),

  agentMode: "autopilot",
  setAgentMode: (agentMode) => set({ agentMode }),
  agentEffort: null,
  setAgentEffort: (agentEffort) => set({ agentEffort }),
  pendingApproval: null,
  setPendingApproval: (pendingApproval) => set({ pendingApproval }),

  tunnel: { state: "idle" },
  setTunnel: (tunnel) => set({ tunnel }),

  messages: [],
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  appendToLast: (delta) =>
    set((s) => {
      const messages = s.messages.slice();
      const last = messages[messages.length - 1];
      if (last) messages[messages.length - 1] = { ...last, content: last.content + delta };
      return { messages };
    }),
  agentRunning: false,
  agentStatus: "",
  setAgentRunning: (agentRunning, agentStatus) =>
    set((s) => ({ agentRunning, agentStatus: agentStatus ?? s.agentStatus })),
  setAgentStatus: (agentStatus) => set({ agentStatus }),
  resetChat: () => set({ messages: [], agentRunning: false, agentStatus: "" }),
  loadChatForProject: (project) =>
    set({
      messages: loadChat(get().userId, project),
      agentRunning: false,
      agentStatus: "",
      pendingApproval: null,
    }),
  clearActiveChat: () => {
    const { userId, activeProject } = get();
    if (activeProject) clearChat(userId, activeProject);
    set({ messages: [], agentRunning: false, agentStatus: "" });
  },
}));
