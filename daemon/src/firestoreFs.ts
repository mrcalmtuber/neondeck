import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FieldValue, FieldPath } from "firebase-admin/firestore";
import type { Firestore, DocumentReference } from "firebase-admin/firestore";
import { firestoreHandle } from "./firebaseAdmin.js";
import { safeResolve } from "./workspace.js";
import { DB_FILENAME, consistentDbCopy } from "./db.js";
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
 * v2 layout — incremental and content-addressed (a mini git):
 *   collection "neondeck_fs":
 *     doc "<userKey>__<project>"  → { userKey, project, v: 2, gen, updatedAt,
 *                                     fileCount, totalBytes, truncated,
 *                                     skipped: [..≤50], files: [{p,h,s,b,n,z}] }
 *       subcollection "blobs":
 *         doc "<h>", "<h>_1", …   → { data }  (≤900k-char slices of
 *                                     base64(gzip(raw bytes)))
 *
 * `files` is an ARRAY (paths contain "." and "/" — illegal in Firestore field
 * names). Per entry: p = posix rel path, h = sha256(raw)[:40], s = raw bytes,
 * b = 1 if binary, n = blob doc count, z = stored base64 chars (quota math
 * without re-gzipping unchanged files). Only CHANGED content uploads on a sync
 * (diff vs the in-memory manifest cache), and the manifest is written LAST so a
 * crash mid-upload leaves the previous manifest fully consistent — orphaned
 * blobs are harmless and swept by a best-effort GC afterwards.
 *
 * Binary files (images, fonts, the project's storage.db) are first-class now.
 * The old v1 format (gzip of the whole project in a "chunks" subcollection)
 * is still restorable; the first v2 snapshot migrates it and clears the chunks.
 *
 * Everything here is guarded/non-fatal: a Firestore hiccup must never break
 * the IDE — worst case a sync is skipped and retried on the next debounce.
 */

const COLLECTION = "neondeck_fs";
/** Never snapshot these (mirrors the workspace + GitHub ignore sets). */
const IGNORED = new Set(["node_modules", ".git", "dist", ".next", ".neondeck", ".DS_Store"]);

const CHUNK_CHARS = 900_000; // base64 chars per blob doc (keeps each doc < 1 MiB)
const BATCH_OPS = 450; // Firestore hard cap is 500 ops per batch
const BATCH_CHARS = 8_000_000; // stay under Firestore's ~10 MiB per-request cap
const MANIFEST_MAX_FILES = 4000; // ~130 B/entry keeps the manifest doc ≈ 500 KB
const HASH_LEN = 40;
const SKIPPED_LIST_MAX = 50; // paths recorded on the manifest doc (not a data cap)
const RESTORE_GETALL_BATCH = 100;
const MANIFEST_CACHE_MAX = 100;

interface ManifestEntry {
  p: string; // posix relative path
  h: string; // sha256(raw bytes) hex, first 40 chars
  s: number; // raw byte size
  b: 0 | 1; // binary?
  n: number; // blob doc count ("<h>", "<h>_1", …)
  z: number; // stored base64 chars (quota accounting)
}

interface CachedManifest {
  gen: number;
  entries: ManifestEntry[];
  hashes: Set<string>;
  digest: string;
}

export interface SnapshotResult {
  truncated: boolean;
  skipped: string[];
}

/** Last-synced manifest per project doc — makes diffs free and lets an
 *  unchanged flush cost ZERO Firestore ops. Module-level (not per-Session):
 *  apiRuns.ts snapshots without a session, and two tabs of one user share the
 *  same workspace so they must share one coherent base. */
const manifestCache = new Map<string, CachedManifest>();
/** Per-doc promise chain so a debounced sync and a shutdown flush can't
 *  interleave blob uploads/GC for the same project. */
const syncLocks = new Map<string, Promise<void>>();

/** True when Firestore-backed snapshots are available on this daemon. */
export function snapshotEnabled(config: DaemonConfig): boolean {
  return Boolean(config.firebaseServiceAccount) && firestoreHandle() != null;
}

/** Firestore doc IDs can't contain "/"; userKeys/projects are otherwise safe. */
function docId(userKey: string, project: string): string {
  return `${userKey}__${project}`.replace(/\//g, "_");
}

function hashOf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, HASH_LEN);
}

/** Order-insensitive fingerprint of a manifest (entries are kept path-sorted). */
function digestOf(entries: ManifestEntry[]): string {
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.p}\0${e.h}\n`);
  return h.digest("hex");
}

function toCached(gen: number, raw: ManifestEntry[]): CachedManifest {
  const entries = raw
    .filter((e) => e && typeof e.p === "string" && typeof e.h === "string")
    .map((e) => ({
      p: e.p,
      h: e.h,
      s: Number(e.s) || 0,
      b: e.b ? (1 as const) : (0 as const),
      n: Math.max(1, Number(e.n) || 1),
      z: Math.max(0, Number(e.z) || 0),
    }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return { gen, entries, hashes: new Set(entries.map((e) => e.h)), digest: digestOf(entries) };
}

function cacheSet(id: string, m: CachedManifest): void {
  if (!manifestCache.has(id) && manifestCache.size >= MANIFEST_CACHE_MAX) {
    const oldest = manifestCache.keys().next().value;
    if (oldest !== undefined) manifestCache.delete(oldest);
  }
  manifestCache.set(id, m);
}

/** NUL byte in the first 8 KB ⇒ treat as binary (stored fine either way; the
 *  flag only drives quota priority and tooling). */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

interface GatheredFile {
  p: string;
  s: number;
  b: 0 | 1;
  buf: Buffer;
  h: string;
}

/** Recursively gather project files, honoring IGNORED and the per-file cap.
 *  Binary files are KEPT (v2); storage.db is skipped here — the caller adds a
 *  transactionally-consistent copy of it instead. */
function gatherFiles(srcDir: string, maxFileBytes: number, skipped: string[]): GatheredFile[] {
  const out: GatheredFile[] = [];
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
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel === DB_FILENAME) continue; // added via consistentDbCopy
      let buf: Buffer;
      try {
        const stat = fs.statSync(abs);
        if (stat.size > maxFileBytes) {
          skipped.push(rel);
          continue;
        }
        buf = fs.readFileSync(abs);
      } catch {
        continue;
      }
      out.push({ p: rel, s: buf.length, b: isBinary(buf) ? 1 : 0, buf, h: hashOf(buf) });
    }
  };
  walk(root);
  return out;
}

/** Snapshot a project to Firestore (incremental). No-op when disabled or the
 *  dir is missing; returns what was skipped so the server can warn the user. */
export async function snapshotProject(
  config: DaemonConfig,
  userKey: string,
  project: string,
  srcDir: string,
  opts?: { db?: DatabaseSync | null },
): Promise<SnapshotResult | undefined> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return undefined;
  const id = docId(userKey, project);
  const prev = syncLocks.get(id) ?? Promise.resolve();
  const run = prev.then(async () => {
    try {
      return await doSnapshot(db, config, userKey, project, srcDir, id, opts?.db ?? null);
    } catch (err) {
      manifestCache.delete(id); // force a fresh manifest read next sync
      console.warn(`[firestore-fs] snapshot of "${project}" failed:`, (err as Error).message);
      return undefined;
    }
  });
  const settled = run.then(() => undefined);
  syncLocks.set(id, settled);
  const result = await run;
  if (syncLocks.get(id) === settled) syncLocks.delete(id);
  return result;
}

async function doSnapshot(
  db: Firestore,
  config: DaemonConfig,
  userKey: string,
  project: string,
  srcDir: string,
  id: string,
  openDb: DatabaseSync | null,
): Promise<SnapshotResult | undefined> {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return undefined;
  const maxFileBytes = Math.max(1, config.fsMaxFileMb) * 1_000_000;
  const quotaChars = Math.max(1, config.fsProjectQuotaMb) * 1_000_000;

  const skipped: string[] = [];
  const candidates = gatherFiles(srcDir, maxFileBytes, skipped);
  const dbCopy = consistentDbCopy(srcDir, openDb);
  if (dbCopy) {
    if (dbCopy.length <= maxFileBytes) {
      candidates.push({
        p: DB_FILENAME,
        s: dbCopy.length,
        b: 1,
        buf: dbCopy,
        h: hashOf(dbCopy),
      });
    } else {
      skipped.push(DB_FILENAME);
    }
  }

  // Base manifest: the in-memory cache, else ONE read. Legacy/missing ⇒ empty
  // base (full upload — which is also how a v1 doc migrates to v2).
  const ref = db.collection(COLLECTION).doc(id);
  let base = manifestCache.get(id) ?? null;
  let legacyDoc = false;
  if (!base) {
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    if (data && data.v === 2 && Array.isArray(data.files)) {
      base = toCached(Number(data.gen) || 0, data.files as ManifestEntry[]);
    } else if (data && Number(data.chunkCount) > 0) {
      legacyDoc = true;
    }
  }

  // Deterministic quota order: storage.db, then text smallest-first, then
  // binary — over quota we shed the biggest assets, never source files.
  const prio = (f: GatheredFile): number => (f.p === DB_FILENAME ? 0 : f.b === 0 ? 1 : 2);
  candidates.sort(
    (a, b) => prio(a) - prio(b) || a.s - b.s || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0),
  );

  const baseByHash = new Map<string, ManifestEntry>();
  for (const e of base?.entries ?? []) if (!baseByHash.has(e.h)) baseByHash.set(e.h, e);

  const entries: ManifestEntry[] = [];
  const uploads = new Map<string, string>(); // hash -> full base64 payload
  const sized = new Map<string, { z: number; n: number }>(); // unique kept hashes
  let usedChars = 0;
  let totalBytes = 0;
  for (const f of candidates) {
    if (entries.length >= MANIFEST_MAX_FILES) {
      skipped.push(f.p);
      continue;
    }
    let zn = sized.get(f.h) ?? null;
    let b64: string | null = null; // non-null ⇔ content is new ⇒ needs upload
    if (!zn) {
      const known = baseByHash.get(f.h);
      if (known) {
        zn = { z: known.z, n: known.n }; // unchanged: reuse size, skip the gzip
      } else {
        b64 = zlib.gzipSync(f.buf).toString("base64");
        zn = { z: b64.length, n: Math.max(1, Math.ceil(b64.length / CHUNK_CHARS)) };
      }
    }
    const cost = sized.has(f.h) ? 0 : zn.z; // duplicate content shares one blob
    if (usedChars + cost > quotaChars) {
      skipped.push(f.p);
      continue;
    }
    usedChars += cost;
    totalBytes += f.s;
    if (!sized.has(f.h)) {
      sized.set(f.h, zn);
      if (b64 !== null) uploads.set(f.h, b64);
    }
    entries.push({ p: f.p, h: f.h, s: f.s, b: f.b, n: zn.n, z: zn.z });
  }
  entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));

  const digest = digestOf(entries);
  const truncated = skipped.length > 0;
  const result: SnapshotResult = { truncated, skipped };

  // Fast path: nothing changed ⇒ ZERO Firestore ops (shutdown flushes and the
  // post-restore sync are free).
  if (base && base.digest === digest && uploads.size === 0) return result;

  // 1) Upload new blobs, batched on op count AND payload size.
  let batch = db.batch();
  let ops = 0;
  let chars = 0;
  const flush = async (): Promise<void> => {
    if (ops === 0) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
    chars = 0;
  };
  for (const [h, b64] of uploads) {
    for (let i = 0, part = 0; i < b64.length; i += CHUNK_CHARS, part++) {
      const slice = b64.slice(i, i + CHUNK_CHARS);
      if (ops >= BATCH_OPS || chars + slice.length > BATCH_CHARS) await flush();
      batch.set(ref.collection("blobs").doc(part === 0 ? h : `${h}_${part}`), { data: slice });
      ops++;
      chars += slice.length;
    }
  }
  await flush();

  // 2) Manifest LAST, without merge — atomically flips a legacy doc to v2 and
  // guarantees a crash above leaves the previous manifest fully consistent.
  // Deliberately drops any warnedAt/archivedAt lifecycle flags: a real sync IS
  // activity, and an archived project that still syncs (it was live on some
  // host's disk) is legitimately un-archived.
  const gen = (base?.gen ?? 0) + 1;
  const hashes = new Set(entries.map((e) => e.h));
  const now = Date.now();
  await ref.set({
    userKey,
    project,
    v: 2,
    gen,
    updatedAt: now,
    lastActiveAt: now,
    fileCount: entries.length,
    totalBytes,
    truncated,
    skipped: skipped.slice(0, SKIPPED_LIST_MAX),
    files: entries,
  });
  cacheSet(id, { gen, entries, hashes, digest });

  // 3) Best-effort cleanup, NOT awaited (keeps the shutdown flush fast): sweep
  // unreferenced blobs, and the v1 chunks after a migration.
  const removedContent = base ? [...base.hashes].some((h) => !hashes.has(h)) : false;
  if (uploads.size > 0 || removedContent || legacyDoc) {
    void gcBlobs(ref, hashes).catch(() => {});
  }
  if (legacyDoc) void deleteSubcollection(ref, "chunks").catch(() => {});
  return result;
}

/** Delete blob docs the manifest no longer references. Safe because the
 *  manifest is written last: everything it points at exists. */
async function gcBlobs(ref: DocumentReference, referenced: Set<string>): Promise<void> {
  const docs = await ref.collection("blobs").listDocuments();
  const stale = docs.filter((d) => !referenced.has(d.id.split("_")[0]));
  for (let i = 0; i < stale.length; i += BATCH_OPS) {
    const batch = ref.firestore.batch();
    for (const d of stale.slice(i, i + BATCH_OPS)) batch.delete(d);
    await batch.commit();
  }
}

async function deleteSubcollection(ref: DocumentReference, name: string): Promise<void> {
  const docs = await ref.collection(name).listDocuments();
  for (let i = 0; i < docs.length; i += BATCH_OPS) {
    const batch = ref.firestore.batch();
    for (const d of docs.slice(i, i + BATCH_OPS)) batch.delete(d);
    await batch.commit();
  }
}

interface FetchedSnapshot {
  files: Map<string, Buffer>; // posix relPath -> raw bytes
  cached: CachedManifest | null; // null for legacy v1 snapshots
}

/** Fetch and reassemble a snapshot's full file set (v2 blobs OR legacy chunks)
 *  without touching the local disk. Null when no snapshot exists. May throw —
 *  the public wrappers guard it. */
async function fetchSnapshotInternal(
  db: Firestore,
  ref: DocumentReference,
  project: string,
): Promise<FetchedSnapshot | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown>;

  // Legacy v1: whole-project gzip JSON in the "chunks" subcollection.
  if (!(data.v === 2 && Array.isArray(data.files))) {
    const count = Number(data.chunkCount ?? 0);
    if (count <= 0) return null;
    const chunkSnap = await ref.collection("chunks").get();
    const parts: string[] = new Array(count).fill("");
    for (const doc of chunkSnap.docs) {
      const i = Number(doc.id);
      if (i >= 0 && i < count) parts[i] = (doc.data() as { data?: string }).data ?? "";
    }
    const json = zlib.gunzipSync(Buffer.from(parts.join(""), "base64")).toString("utf8");
    const { files } = JSON.parse(json) as { files: Record<string, string> };
    const map = new Map<string, Buffer>();
    for (const [rel, content] of Object.entries(files)) {
      map.set(rel, Buffer.from(content, "utf8"));
    }
    return { files: map, cached: null };
  }

  // v2: fetch every unique blob's slices via getAll (batched RPCs), then
  // reassemble + integrity-check. A bad blob skips its file(s), never the lot.
  const cached = toCached(Number(data.gen) || 0, data.files as ManifestEntry[]);
  const blobDocCount = new Map<string, number>();
  for (const e of cached.entries) {
    if (!blobDocCount.has(e.h)) blobDocCount.set(e.h, e.n);
  }
  const refs: DocumentReference[] = [];
  for (const [h, n] of blobDocCount) {
    for (let part = 0; part < n; part++) {
      refs.push(ref.collection("blobs").doc(part === 0 ? h : `${h}_${part}`));
    }
  }
  const slices = new Map<string, string>();
  for (let i = 0; i < refs.length; i += RESTORE_GETALL_BATCH) {
    const group = refs.slice(i, i + RESTORE_GETALL_BATCH);
    const snaps = await db.getAll(...group);
    for (const s of snaps) {
      if (s.exists) slices.set(s.id, (s.data() as { data?: string }).data ?? "");
    }
  }
  const contents = new Map<string, Buffer>();
  for (const [h, n] of blobDocCount) {
    let b64 = "";
    let missing = false;
    for (let part = 0; part < n; part++) {
      const s = slices.get(part === 0 ? h : `${h}_${part}`);
      if (s === undefined) {
        missing = true;
        break;
      }
      b64 += s;
    }
    if (missing) {
      console.warn(`[firestore-fs] blob ${h} missing for "${project}" — skipping its file(s)`);
      continue;
    }
    try {
      const buf = zlib.gunzipSync(Buffer.from(b64, "base64"));
      if (hashOf(buf) !== h) {
        console.warn(`[firestore-fs] blob ${h} corrupt for "${project}" — skipping`);
        continue;
      }
      contents.set(h, buf);
    } catch {
      console.warn(`[firestore-fs] blob ${h} unreadable for "${project}" — skipping`);
    }
  }
  const map = new Map<string, Buffer>();
  for (const e of cached.entries) {
    const buf = contents.get(e.h);
    if (buf) map.set(e.p, buf);
  }
  return { files: map, cached };
}

/** A snapshot's files as raw bytes (v2 AND legacy) without writing to disk —
 *  powers the .zip export. Null when disabled or no snapshot. Never throws. */
export async function fetchSnapshotFiles(
  config: DaemonConfig,
  userKey: string,
  project: string,
): Promise<Map<string, Buffer> | null> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return null;
  try {
    const ref = db.collection(COLLECTION).doc(docId(userKey, project));
    const fetched = await fetchSnapshotInternal(db, ref, project);
    return fetched ? fetched.files : null;
  } catch (err) {
    console.warn(`[firestore-fs] fetch of "${project}" failed:`, (err as Error).message);
    return null;
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
  const id = docId(userKey, project);
  try {
    const ref = db.collection(COLLECTION).doc(id);
    const fetched = await fetchSnapshotInternal(db, ref, project);
    if (!fetched) return false;
    fs.mkdirSync(destDir, { recursive: true });
    let wrote = 0;
    for (const [rel, buf] of fetched.files) {
      try {
        const abs = safeResolve(destDir, rel); // jailed, binary-safe write
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        wrote++;
      } catch (err) {
        console.warn(`[firestore-fs] could not restore ${rel}:`, (err as Error).message);
      }
    }
    // Prime the diff cache (v2) so the first post-restore sync is a zero-op
    // fast path; legacy restores drop it so the next sync migrates to v2.
    if (fetched.cached) cacheSet(id, fetched.cached);
    else manifestCache.delete(id);
    console.log(
      `[firestore-fs] restored "${project}" (${wrote}/${fetched.files.size} files) from Firestore`,
    );
    return true;
  } catch (err) {
    console.warn(`[firestore-fs] restore of "${project}" failed:`, (err as Error).message);
    return false;
  }
}

/** Bump a project's activity clock and clear any inactivity warning/archive —
 *  opening IS activity ("come back anytime to refresh"). Returns false when
 *  there is no snapshot manifest. Never throws. */
export async function touchSnapshotActivity(
  config: DaemonConfig,
  userKey: string,
  project: string,
): Promise<boolean> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return false;
  try {
    await db.collection(COLLECTION).doc(docId(userKey, project)).update({
      lastActiveAt: Date.now(),
      warnedAt: FieldValue.delete(),
      archivedAt: FieldValue.delete(),
    });
    return true;
  } catch (err) {
    // gRPC code 5 = NOT_FOUND (no manifest yet — nothing to touch, not an error).
    if ((err as { code?: number }).code !== 5) {
      console.warn(`[firestore-fs] touch of "${project}" failed:`, (err as Error).message);
    }
    return false;
  }
}

export interface SnapshotProjectMeta {
  project: string;
  updatedAt: number;
  lastActiveAt: number | null;
  warnedAt: number | null;
  archivedAt: number | null;
}

/** Per-project snapshot metadata for this user. Projected query — skips the
 *  big `files` arrays, so it stays cheap however large the projects are. */
export async function listSnapshotProjectMeta(
  config: DaemonConfig,
  userKey: string,
): Promise<SnapshotProjectMeta[]> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return [];
  try {
    const res = await db
      .collection(COLLECTION)
      .where("userKey", "==", userKey)
      .select("project", "updatedAt", "lastActiveAt", "warnedAt", "archivedAt")
      .get();
    return res.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          project: String(data.project ?? ""),
          updatedAt: Number(data.updatedAt) || 0,
          lastActiveAt: data.lastActiveAt != null ? Number(data.lastActiveAt) : null,
          warnedAt: data.warnedAt != null ? Number(data.warnedAt) : null,
          archivedAt: data.archivedAt != null ? Number(data.archivedAt) : null,
        };
      })
      .filter((m) => m.project);
  } catch (err) {
    console.warn("[firestore-fs] list failed:", (err as Error).message);
    return [];
  }
}

/** Archived/warned flags for one project (projected read — the manifest doc can
 *  be ~500 KB). Null when disabled or no snapshot. Never throws. */
export async function getSnapshotState(
  config: DaemonConfig,
  userKey: string,
  project: string,
): Promise<{ warnedAt: number | null; archivedAt: number | null } | null> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return null;
  try {
    const res = await db
      .collection(COLLECTION)
      .where(FieldPath.documentId(), "==", docId(userKey, project))
      .select("warnedAt", "archivedAt")
      .get();
    if (res.empty) return null;
    const data = res.docs[0].data() as Record<string, unknown>;
    return {
      warnedAt: data.warnedAt != null ? Number(data.warnedAt) : null,
      archivedAt: data.archivedAt != null ? Number(data.archivedAt) : null,
    };
  } catch (err) {
    console.warn(`[firestore-fs] state check of "${project}" failed:`, (err as Error).message);
    return null;
  }
}

/** Project names this user has snapshotted (to repopulate the Hub after a wipe).
 *  Works for both formats — userKey/project live on the manifest doc in each. */
export async function listSnapshotProjects(
  config: DaemonConfig,
  userKey: string,
): Promise<string[]> {
  return (await listSnapshotProjectMeta(config, userKey)).map((m) => m.project);
}

/** Delete a project's snapshot (manifest + blobs + any legacy chunks). */
export async function deleteSnapshot(
  config: DaemonConfig,
  userKey: string,
  project: string,
): Promise<void> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config)) return;
  const id = docId(userKey, project);
  manifestCache.delete(id);
  try {
    const ref = db.collection(COLLECTION).doc(id);
    await deleteSubcollection(ref, "chunks");
    await deleteSubcollection(ref, "blobs");
    await ref.delete();
  } catch (err) {
    console.warn(`[firestore-fs] delete of "${project}" failed:`, (err as Error).message);
  }
}
