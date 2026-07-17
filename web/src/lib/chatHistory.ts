import type { ChatMessage } from "./store";

/**
 * Per-project, per-user chat persistence (localStorage).
 *
 * The agent conversation otherwise lives only in the in-memory store and is
 * wiped on reload / project switch. We persist it keyed by user + project so a
 * reload restores the same project's history and switching projects swaps to
 * that project's own thread. Single-device by design (the diskless Render free
 * tier can't host this server-side reliably); a future Firestore sync could
 * make it cross-device.
 */

const PREFIX = "ide.chat.";
/** Keep storage bounded: only the most recent messages, each capped in size. */
const MAX_MESSAGES = 250;
const MAX_CONTENT = 16_000; // tool dumps / diffs can be large

function keyFor(userId: string | null, project: string): string {
  return `${PREFIX}${userId || "anon"}.${project}`;
}

/** Load a project's saved chat. Tolerates missing/corrupt data → []. */
export function loadChat(userId: string | null, project: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(keyFor(userId, project));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

/** Persist a project's chat (trimmed + truncated). Non-fatal on quota errors. */
export function saveChat(userId: string | null, project: string, messages: ChatMessage[]): void {
  try {
    const trimmed = messages.slice(-MAX_MESSAGES).map((m) =>
      m.content.length > MAX_CONTENT ? { ...m, content: m.content.slice(0, MAX_CONTENT) + "…" } : m,
    );
    localStorage.setItem(keyFor(userId, project), JSON.stringify(trimmed));
  } catch {
    /* quota / serialization failure — chat just won't persist this turn */
  }
}

/** Forget a project's saved chat. */
export function clearChat(userId: string | null, project: string): void {
  try {
    localStorage.removeItem(keyFor(userId, project));
  } catch {
    /* ignore */
  }
}
