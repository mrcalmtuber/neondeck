import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

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
