import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

/**
 * Optional server-side Firestore (via a service account).
 *
 * Used only to durably persist per-user usage metering so the monthly token
 * limiter survives Render's diskless redeploys (where the local JSON ledger is
 * wiped). The credential is a Firebase service-account key, supplied as
 * FIREBASE_SERVICE_ACCOUNT — either the raw JSON or base64 of it. When absent,
 * the daemon transparently falls back to the on-disk ledger (local dev).
 *
 * This is the ONLY place a service-account secret is read; it never leaves the
 * daemon. (Token VERIFICATION still uses Google's public certs — see auth.ts —
 * and needs no secret; this is purely for Firestore WRITES.)
 */
let firestore: Firestore | null = null;
let adminApp: App | null = null;
let tried = false;

export function initFirestore(serviceAccountRaw: string | undefined): Firestore | null {
  if (tried) return firestore;
  tried = true;
  const raw = (serviceAccountRaw ?? "").trim();
  if (!raw) return null;
  try {
    // Accept raw JSON or base64-encoded JSON (env UIs often mangle multi-line JSON).
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const creds = JSON.parse(json) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    const app: App = getApps().length
      ? getApps()[0]!
      : initializeApp({
          credential: cert({
            projectId: creds.project_id,
            clientEmail: creds.client_email,
            // Env stores literal "\n"; turn them back into real newlines for the PEM.
            privateKey: creds.private_key?.replace(/\\n/g, "\n"),
          }),
        });
    adminApp = app;
    firestore = getFirestore(app);
    console.log(`[firestore] usage persistence enabled (project: ${creds.project_id ?? "?"})`);
  } catch (err) {
    console.warn(
      "[firestore] could not initialize — falling back to local ledger:",
      (err as Error).message,
    );
    firestore = null;
  }
  return firestore;
}

/** The initialized Firestore handle, or null if not configured. (initFirestore
 *  must have run first — it does, at server startup.) */
export function firestoreHandle(): Firestore | null {
  return firestore;
}

/** True when the Admin SDK (service account) is available. */
export function adminAuthAvailable(): boolean {
  return adminApp != null;
}

/**
 * Generate a Firebase password-reset link (Admin SDK) that continues back to
 * `continueUrl` after the reset. Returns null for an unknown email — callers
 * must NOT reveal that to the requester (enumeration). Throws on infra errors
 * so callers can fall back to Firebase's own sender.
 */
export async function generateResetLink(email: string, continueUrl: string): Promise<string | null> {
  if (!adminApp) throw new Error("Admin auth not configured.");
  try {
    return await getAuth(adminApp).generatePasswordResetLink(email.trim(), { url: continueUrl });
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") return null;
    throw err;
  }
}

/**
 * Generate a Firebase email-VERIFICATION link (Admin SDK) that continues back to
 * `continueUrl` after the address is confirmed. Returns null for an unknown /
 * already-verified case that shouldn't be surfaced; throws on infra errors so
 * callers can fall back to Firebase's own client-side sender.
 */
export async function generateEmailVerificationLink(
  email: string,
  continueUrl: string,
): Promise<string | null> {
  if (!adminApp) throw new Error("Admin auth not configured.");
  try {
    return await getAuth(adminApp).generateEmailVerificationLink(email.trim(), { url: continueUrl });
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") return null;
    throw err;
  }
}

/**
 * Look up a user by email via Firebase Admin Auth (needs the service account).
 * Lets an admin manage ANY user — online or not. Returns null if not found or if
 * admin isn't configured.
 */
export async function lookupUserByEmail(
  email: string,
): Promise<{ userId: string; email: string | null } | null> {
  if (!adminApp) return null;
  try {
    const u = await getAuth(adminApp).getUserByEmail(email.trim());
    return { userId: u.uid, email: u.email ?? null };
  } catch {
    return null; // no such user / auth error
  }
}

/** Resolve emails for a batch of uids (for the admin "all users" list). */
export async function lookupEmails(uids: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!adminApp || uids.length === 0) return out;
  try {
    const auth = getAuth(adminApp);
    for (let i = 0; i < uids.length; i += 100) {
      const res = await auth.getUsers(uids.slice(i, i + 100).map((uid) => ({ uid })));
      for (const u of res.users) out[u.uid] = u.email ?? null;
    }
  } catch (err) {
    console.warn("[admin] lookupEmails failed:", (err as Error).message);
  }
  return out;
}
