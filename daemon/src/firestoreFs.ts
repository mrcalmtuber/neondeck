import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { firestoreHandle } from "./firebaseAdmin.js";
import { writeFileSync } from "./workspace.js";
import type { DaemonConfig } from "./config.js";

/**
 * Firestore-backed project storage — the free "persistent disk".
 *
 * Render's free tier has no persistent disk: /data is wiped on every redeploy
 * and after the service sleeps. The user's GitHub repo (githubSync.ts) covers
 * those who connect GitHub; this module is the safety net for EVERYONE ELSE, so
 * no signed-in user loses their projects. It mirrors the githubSync API
 * (snapshot / restore / list / delete) and the server uses it ONLY when the
 * session has no GitHub token.
 *
 * Storage layout (one project = one "manifest" + N "chunk" docs so each doc stays
 * under Firestore's 1 MiB cap):
 *   collection "neondeck_fs":
 *     doc "<userKey>__<project>"            → { userKey, project, chunkCount, updatedAt }
 *       subcollection "chunks":
 *         doc "0", "1", …                   → { data }   (base64 of a gzip slice)
 *
 * A snapshot is gzipped + base64'd JSON of { files: { relPosixPath: content } },
 * so a typical small project is one chunk ⇒ ~2 writes — friendly to the free
 * tier's write quota. Everything here is guarded/non-fatal: a Firestore hiccup
 * must never break the IDE.
 */

const COLLECTION = "neondeck_fs";
/** Never snapshot these (mirrors the workspace + GitHub ignore sets). */
const IGNORED = new Set(["node_modules", ".git", "dist", ".next", ".neondeck", ".DS_Store"]);

const MAX_FILE_BYTES = 1_000_000; // skip files bigger than ~1 MB
const MAX_SNAPSHOT_BYTES = 5_000_000; // cap the raw payload we gather (~5 MB)
const CHUNK_CHARS = 900_000; // base64 chars per chunk doc (keeps each doc < 1 MiB)

/** True when Firestore-backed snapshots are available on this daemon. */
export function snapshotEnabled(config: DaemonConfig): boolean {
  return Boolean(config.firebaseServiceAccount) && firestoreHandle() != null;
}

/** Firestore doc IDs can't contain "/"; userKeys/projects are otherwise safe. */
function docId(userKey: string, project: string): string {
  return `${userKey}__${project}`.replace(/\//g, "_");
}

/** Recursively gather { relPosixPath: content } for a project, honoring IGNORED,
 *  skipping large/binary files, and stopping once the cap is reached. */
function gatherFiles(srcDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  const root = path.resolve(srcDir);
  const walk = (absDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        if (total >= MAX_SNAPSHOT_BYTES) return;
        let content: string;
        try {
          const stat = fs.statSync(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          content = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        if (content.indexOf("\u0000") !== -1) continue; // looks binary — skip
        const rel = path.relative(root, abs).split(path.sep).join("/");
        out[rel] = content;
        total += content.length;
      }
    }
  };
  walk(root);
  return out;
}

/** Snapshot a project to Firestore. No-op when disabled or the dir is missing. */
export async function snapshotProject(
  config: DaemonConfig,
  userKey: string,
  project: string,
  srcDir: string,
): Promise<void> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return;
  try {
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return;
    const files = gatherFiles(srcDir);
    const json = JSON.stringify({ files });
    const b64 = zlib.gzipSync(Buffer.from(json, "utf8")).toString("base64");

    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.slice(i, i + CHUNK_CHARS));

    const ref = db.collection(COLLECTION).doc(docId(userKey, project));
    // Find any stale chunk docs from a previous (larger) snapshot to delete.
    const existing = await ref.collection("chunks").listDocuments();
    const batch = db.batch();
    batch.set(ref, { userKey, project, chunkCount: chunks.length, updatedAt: Date.now() });
    chunks.forEach((data, i) => batch.set(ref.collection("chunks").doc(String(i)), { data }));
    for (const d of existing) {
      if (Number(d.id) >= chunks.length) batch.delete(d);
    }
    await batch.commit();
  } catch (err) {
    console.warn(`[firestore-fs] snapshot of "${project}" failed:`, (err as Error).message);
  }
}

/** Restore a project from Firestore into destDir. Returns whether it restored. */
export async function restoreProject(
  config: DaemonConfig,
  userKey: string,
  project: string,
  destDir: string,
): Promise<boolean> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return false;
  try {
    const ref = db.collection(COLLECTION).doc(docId(userKey, project));
    const manifest = await ref.get();
    if (!manifest.exists) return false;
    const count = Number((manifest.data() as { chunkCount?: number })?.chunkCount ?? 0);
    if (count <= 0) return false;

    const snap = await ref.collection("chunks").get();
    const parts: string[] = new Array(count).fill("");
    for (const doc of snap.docs) {
      const i = Number(doc.id);
      if (i >= 0 && i < count) parts[i] = (doc.data() as { data?: string }).data ?? "";
    }
    const b64 = parts.join("");
    const json = zlib.gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
    const { files } = JSON.parse(json) as { files: Record<string, string> };

    fs.mkdirSync(destDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(destDir, rel, content); // jailed via safeResolve
    }
    console.log(`[firestore-fs] restored "${project}" from Firestore`);
    return true;
  } catch (err) {
    console.warn(`[firestore-fs] restore of "${project}" failed:`, (err as Error).message);
    return false;
  }
}

/** Project names this user has snapshotted (to repopulate the Hub after a wipe). */
export async function listSnapshotProjects(
  config: DaemonConfig,
  userKey: string,
): Promise<string[]> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return [];
  try {
    const res = await db.collection(COLLECTION).where("userKey", "==", userKey).get();
    return res.docs
      .map((d) => (d.data() as { project?: string }).project ?? "")
      .filter(Boolean);
  } catch (err) {
    console.warn("[firestore-fs] list failed:", (err as Error).message);
    return [];
  }
}

/** Delete a project's snapshot (manifest + all chunks) so its slot is freed. */
export async function deleteSnapshot(
  config: DaemonConfig,
  userKey: string,
  project: string,
): Promise<void> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return;
  try {
    const ref = db.collection(COLLECTION).doc(docId(userKey, project));
    const chunks = await ref.collection("chunks").listDocuments();
    const batch = db.batch();
    for (const d of chunks) batch.delete(d);
    batch.delete(ref);
    await batch.commit();
  } catch (err) {
    console.warn(`[firestore-fs] delete of "${project}" failed:`, (err as Error).message);
  }
}
