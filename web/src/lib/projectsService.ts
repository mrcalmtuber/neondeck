import {
  doc,
  setDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebaseClient";
import type { AuthSession } from "./firebaseClient";

/**
 * Resolve `p`, or `fallback` if it hasn't settled within `ms`. Firestore's
 * transport can stall indefinitely (e.g. Safari blocking cross-site requests),
 * which would otherwise leave callers — and the Projects tab — hung forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => finish(fallback), ms);
    p.then(finish, () => finish(fallback));
  });
}

const FIRESTORE_TIMEOUT_MS = 6000;

/**
 * Firestore data layer (NeonDeck). Two collections back the product:
 *
 *   users/{uid}            — one profile doc per signed-in account
 *   projects/{auto-id}     — one record per provisioned workspace, owned by a uid
 *
 * Every call is wrapped defensively: a Firestore hiccup (offline, rules, an
 * unconfigured project) must NEVER block provisioning or the dashboard — the
 * workspace still mounts locally. Failures are logged and swallowed.
 */

export interface ProjectRecord {
  id: string;
  name: string;
  idea: string;
  template: string | null;
  createdAtMs: number;
}

/** Upsert the signed-in user's profile doc (called once after login). */
export async function ensureUserDoc(session: AuthSession): Promise<void> {
  try {
    await withTimeout(
      setDoc(
        doc(db, "users", session.userId),
        {
          uid: session.userId,
          email: session.email ?? null,
          lastSeen: serverTimestamp(),
        },
        { merge: true },
      ),
      FIRESTORE_TIMEOUT_MS,
      undefined,
    );
  } catch (err) {
    console.warn("[firestore] ensureUserDoc failed (non-fatal):", err);
  }
}

/**
 * Save the initial record for a freshly provisioned project. Returns the new
 * Firestore document id, or null if the write didn't land (offline / rules).
 */
export async function saveProjectRecord(opts: {
  userId: string;
  name: string;
  idea?: string;
  template?: string | null;
}): Promise<string | null> {
  try {
    const ref = await withTimeout<Awaited<ReturnType<typeof addDoc>> | null>(
      addDoc(collection(db, "projects"), {
        userId: opts.userId,
        name: opts.name,
        idea: opts.idea ?? "",
        template: opts.template ?? null,
        createdAt: serverTimestamp(),
      }),
      FIRESTORE_TIMEOUT_MS,
      null,
    );
    return ref ? ref.id : null;
  } catch (err) {
    console.warn("[firestore] saveProjectRecord failed (non-fatal):", err);
    return null;
  }
}

/** List the signed-in user's projects, newest first. Empty array on any error. */
export async function listUserProjects(userId: string): Promise<ProjectRecord[]> {
  try {
    const q = query(
      collection(db, "projects"),
      where("userId", "==", userId),
      orderBy("createdAt", "desc"),
    );
    const snap = await withTimeout<Awaited<ReturnType<typeof getDocs>> | null>(
      getDocs(q),
      FIRESTORE_TIMEOUT_MS,
      null,
    );
    if (!snap) return []; // timed out (e.g. Firestore blocked) — don't hang the UI
    return snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      const created = data.createdAt as { toMillis?: () => number } | undefined;
      return {
        id: d.id,
        name: String(data.name ?? d.id),
        idea: String(data.idea ?? ""),
        template: (data.template as string | null) ?? null,
        createdAtMs: created?.toMillis?.() ?? 0,
      };
    });
  } catch (err) {
    console.warn("[firestore] listUserProjects failed (non-fatal):", err);
    return [];
  }
}
