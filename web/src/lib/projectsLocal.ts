/**
 * Local-first project index (localStorage).
 *
 * The Projects tab needs to show every project the user creates even before the
 * daemon list refreshes, and Firestore needs a real token and is blocked in some
 * browsers (Safari ITP). This index is the durable, always-available record so a
 * created project never silently vanishes from the tab. It is MERGED with the
 * daemon/Firestore lists (deduped by name), never the sole source.
 */

const KEY = "neondeck.projects";

export interface LocalProject {
  name: string;
  idea?: string;
  template?: string | null;
  /** Transport the project was created with. Always "daemon" now; kept for
   *  backward-compat with older stored records. */
  transport?: "daemon";
  createdAtMs: number;
}

function read(): LocalProject[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as LocalProject[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(list: LocalProject[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

/** Insert or update a project by name; keeps the original createdAt on update. */
export function recordLocalProject(p: {
  name: string;
  idea?: string;
  template?: string | null;
  transport?: "daemon";
}): void {
  if (!p.name) return;
  const list = read();
  const existing = list.find((x) => x.name === p.name);
  if (existing) {
    existing.idea = p.idea ?? existing.idea;
    existing.template = p.template ?? existing.template ?? null;
    existing.transport = p.transport ?? existing.transport;
  } else {
    list.push({
      name: p.name,
      idea: p.idea,
      template: p.template ?? null,
      transport: p.transport,
      createdAtMs: Date.now(),
    });
  }
  write(list);
}

/** All locally-known projects, newest first. */
export function listLocalProjects(): LocalProject[] {
  return read().sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function removeLocalProject(name: string): void {
  write(read().filter((x) => x.name !== name));
}
