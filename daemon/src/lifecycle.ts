import { firestoreHandle, lookupEmails } from "./firebaseAdmin.js";
import { snapshotEnabled, deleteSnapshot } from "./firestoreFs.js";
import { sendResendEmail, projectWarningHtml, projectArchivedHtml } from "./devEmail.js";
import type { UsageStore } from "./usage.js";
import type { DaemonConfig } from "./config.js";

/**
 * Snapshot inactivity lifecycle — keeps the free Firestore "persistent disk"
 * from filling up with abandoned projects.
 *
 *   30 days idle  → warning email ("open it within 2 days to keep it")
 *   +48 hours     → archived (open blocked; only Restore / Download .zip)
 *   +24 hours     → permanently deleted
 *
 * Activity = opening the project or any snapshot write; both clear the flags
 * (server.ts touchSnapshotActivity / the manifest set() in firestoreFs.ts).
 * GitHub-connected sessions never write neondeck_fs docs, so their projects
 * are naturally exempt — a stale snapshot left behind from before they
 * connected will age out, which is fine (their data lives in their repo).
 * API runs (apiRuns.ts) also count: their finalize snapshot un-archives.
 *
 * Everything here is best-effort and non-fatal. State transitions use a
 * lastUpdateTime precondition so a live sync racing the sweep makes the
 * transition fail cleanly (skipped that pass, retried the next).
 *
 * Cost: one projected read per manifest per pass (hourly) — trivial at indie
 * scale, no composite index needed.
 */

const COLLECTION = "neondeck_fs";

export async function sweepSnapshotLifecycle(
  config: DaemonConfig,
  store: UsageStore,
): Promise<void> {
  const db = firestoreHandle();
  if (!db || !snapshotEnabled(config) || !config.fsLifecycleEnabled) return;
  const now = Date.now();
  const inactiveMs = config.fsInactiveDays * 86_400_000;
  const warnMs = config.fsWarnGraceHours * 3_600_000;
  const archMs = config.fsArchiveGraceHours * 3_600_000;
  const emailCache = new Map<string, string | null>();

  let docs;
  try {
    const res = await db
      .collection(COLLECTION)
      .select("userKey", "project", "updatedAt", "lastActiveAt", "warnedAt", "archivedAt")
      .get();
    docs = res.docs;
  } catch (err) {
    console.warn("[fs-lifecycle] sweep query failed:", (err as Error).message);
    return;
  }

  for (const doc of docs) {
    try {
      const data = doc.data() as Record<string, unknown>;
      const userKey = String(data.userKey ?? "");
      const project = String(data.project ?? "");
      if (!userKey || !project || userKey === "local-dev") continue; // local dev disk is persistent

      const lastActiveAt = data.lastActiveAt != null ? Number(data.lastActiveAt) : 0;
      const updatedAt = data.updatedAt != null ? Number(data.updatedAt) : 0;
      const warnedAt = data.warnedAt != null ? Number(data.warnedAt) : 0;
      const archivedAt = data.archivedAt != null ? Number(data.archivedAt) : 0;
      const lastActive = lastActiveAt || updatedAt;

      if (!lastActive) {
        // Ancient doc with no timestamps at all: start its clock instead of
        // instantly warning on unknown age.
        await doc.ref.update({ lastActiveAt: now }, { lastUpdateTime: doc.updateTime });
        continue;
      }

      // One stage per pass, checked most-terminal first.
      if (archivedAt) {
        if (now - archivedAt <= archMs) continue;
        // Re-read fresh right before the irreversible step: a restore/sync
        // since our query would have cleared archivedAt.
        const fresh = await doc.ref.get();
        const freshArchived = Number((fresh.data() as { archivedAt?: number })?.archivedAt ?? 0);
        if (!fresh.exists || freshArchived !== archivedAt) continue;
        await deleteSnapshot(config, userKey, project);
        console.log(`[fs-lifecycle] permanently deleted idle project "${project}" (${userKey})`);
        continue;
      }

      if (warnedAt) {
        if (now - warnedAt <= warnMs) continue;
        await doc.ref.update({ archivedAt: now }, { lastUpdateTime: doc.updateTime });
        console.log(`[fs-lifecycle] archived "${project}" (${userKey})`);
        await notify(config, store, emailCache, userKey, {
          subject: `"${project}" has been archived — restore it within 24 hours`,
          html: projectArchivedHtml(project, config.appOrigin),
        });
        continue;
      }

      if (now - lastActive > inactiveMs) {
        await doc.ref.update({ warnedAt: now }, { lastUpdateTime: doc.updateTime });
        console.log(`[fs-lifecycle] warned "${project}" (${userKey})`);
        await notify(config, store, emailCache, userKey, {
          subject: `Your Kryct project "${project}" will be archived in 2 days`,
          html: projectWarningHtml(project, config.appOrigin),
        });
      }
    } catch (err) {
      // FAILED_PRECONDITION here means a live sync beat us to the doc — the
      // project is active again, so skipping is exactly right.
      const msg = (err as Error).message ?? "";
      if (!/FAILED_PRECONDITION|precondition/i.test(msg)) {
        console.warn(`[fs-lifecycle] doc ${doc.id} failed:`, msg);
      }
    }
  }
}

/** Send a lifecycle email, best-effort. These are TRANSACTIONAL data-loss
 *  notices, deliberately not gated on marketing consent/unsubscribe; a failed
 *  or impossible send never blocks the state machine (the dashboard pill is
 *  the in-app fallback). userKey == Firebase uid (safeUserId is identity for
 *  Firebase's alnum uids). */
async function notify(
  config: DaemonConfig,
  store: UsageStore,
  cache: Map<string, string | null>,
  userKey: string,
  mail: { subject: string; html: string },
): Promise<void> {
  if (!config.resendApiKey) return;
  try {
    let email = cache.get(userKey);
    if (email === undefined) {
      email = store.emailFor(userKey);
      if (!email) email = (await lookupEmails([userKey]))[userKey] ?? null;
      cache.set(userKey, email);
    }
    if (!email) return;
    await sendResendEmail(config, {
      from: config.devEmailFrom,
      to: email,
      subject: mail.subject,
      html: mail.html,
    });
  } catch (err) {
    console.warn(`[fs-lifecycle] email to ${userKey} failed:`, (err as Error).message);
  }
}
