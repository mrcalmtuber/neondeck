import path from "node:path";
import fs from "node:fs";
import { X509Certificate, verify as cryptoVerify } from "node:crypto";
import type { DaemonConfig } from "./config.js";

/**
 * Central authentication (Firebase).
 *
 * When a Firebase project id is configured (default: "neondeck-production"),
 * the daemon verifies the browser's Firebase ID token (a JWT) server-side. The
 * token is checked against Google's public signing certificates (RS256) and its
 * claims (audience / issuer / expiry) — no service-account private key is
 * required, because verification only needs the PUBLIC certs. The daemon then
 * trusts only the uid in the verified token.
 *
 * When no project id is configured (FIREBASE_PROJECT_ID=""), the daemon runs in
 * a clearly-logged local "dev" mode: a single user `local-dev` so the IDE still
 * works fully offline.
 */

export type AuthMode = "firebase" | "dev";

export interface AuthedUser {
  userId: string;
  email: string | null;
  mode: AuthMode;
}

export const DEV_USER_ID = "local-dev";

/** Google's public x509 certs for Firebase ID tokens (Secure Token service). */
const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

export function authConfigured(config: DaemonConfig): boolean {
  return Boolean(config.firebaseProjectId);
}

// ---- public cert cache (respects the endpoint's Cache-Control max-age) ----
let certCache: { certs: Record<string, string>; expiresAt: number } | null = null;

async function getCerts(): Promise<Record<string, string>> {
  if (certCache && Date.now() < certCache.expiresAt) return certCache.certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Could not fetch Firebase signing certs (HTTP ${res.status}).`);
  const certs = (await res.json()) as Record<string, string>;
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
  const ttlMs = (maxAge ? Number(maxAge) : 3600) * 1000;
  certCache = { certs, expiresAt: Date.now() + ttlMs };
  return certs;
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(b64urlToBuffer(seg).toString("utf8"));
}

/**
 * Verify a Firebase ID token end-to-end. Throws on any failure. Returns the
 * decoded uid + email on success. Follows Google's documented manual
 * verification (header alg/kid → matching public cert → RS256 signature →
 * aud/iss/exp/iat/sub claim checks).
 */
async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
): Promise<{ uid: string; email: string | null }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token.");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeSegment(headerB64) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`Unexpected token algorithm: ${header.alg}.`);
  if (!header.kid) throw new Error("Token is missing a key id (kid).");

  const certs = await getCerts();
  const certPem = certs[header.kid];
  if (!certPem) throw new Error("Token signed with an unknown / rotated key.");

  const publicKey = new X509Certificate(certPem).publicKey;
  const ok = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    b64urlToBuffer(sigB64),
  );
  if (!ok) throw new Error("Token signature verification failed.");

  const claims = decodeSegment(payloadB64) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
  };
  const now = Math.floor(Date.now() / 1000);
  const skew = 60; // tolerate small clock drift
  if (claims.aud !== projectId) throw new Error("Token audience does not match this project.");
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error("Token issuer is not the expected Firebase project.");
  }
  if (!claims.sub) throw new Error("Token has no subject (uid).");
  if (typeof claims.exp !== "number" || claims.exp < now - skew) throw new Error("Token has expired.");
  if (typeof claims.iat === "number" && claims.iat > now + skew) throw new Error("Token issued in the future.");

  return { uid: claims.sub, email: claims.email ?? null };
}

/**
 * Resolve the caller from a handshake. Returns the authed user or throws.
 * In dev mode the token is ignored and the fixed dev user is returned.
 */
export async function authenticate(
  config: DaemonConfig,
  token: string | undefined,
): Promise<AuthedUser> {
  if (!authConfigured(config)) {
    return { userId: DEV_USER_ID, email: null, mode: "dev" };
  }
  if (!token) throw new Error("Authentication required: no Firebase ID token supplied.");

  const { uid, email } = await verifyFirebaseIdToken(token, config.firebaseProjectId);
  return { userId: uid, email, mode: "firebase" };
}

/** Filesystem-safe slug for a user id (Firebase uids are alnum; be defensive). */
function safeUserId(userId: string): string {
  return userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "anon";
}

/**
 * Per-tenant project root. The local dev user keeps the global root (so existing
 * projects stay visible); real users get an isolated `users/<id>` subtree.
 */
export function userRoot(config: DaemonConfig, user: AuthedUser): string {
  if (user.mode === "dev") {
    fs.mkdirSync(config.projectsRoot, { recursive: true });
    return config.projectsRoot;
  }
  const dir = path.join(config.projectsRoot, "users", safeUserId(user.userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
