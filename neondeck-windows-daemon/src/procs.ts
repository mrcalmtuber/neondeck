import { spawn } from "node:child_process";
import type { ProcessInfo } from "./shared/protocol.js";

/**
 * Per-session registry of running background processes, powering the visual
 * Service & Port Control dashboard (Feature C). Tracks metadata + a killer for
 * each process so beginners can stop runaway tasks without a terminal.
 */
interface Entry {
  meta: ProcessInfo;
  kill: () => void;
}

export class ProcRegistry {
  private map = new Map<string, Entry>();

  add(meta: ProcessInfo, kill: () => void): void {
    this.map.set(meta.id, { meta, kill });
  }

  remove(id: string): void {
    this.map.delete(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  setPid(id: string, pid: number | null): void {
    const e = this.map.get(id);
    if (e) e.meta.pid = pid;
  }

  /** Kill one process by id. Returns true if it existed. */
  kill(id: string): boolean {
    const e = this.map.get(id);
    if (!e) return false;
    e.kill();
    this.map.delete(id);
    return true;
  }

  killAll(): void {
    for (const e of this.map.values()) e.kill();
    this.map.clear();
  }

  list(): ProcessInfo[] {
    return [...this.map.values()].map((e) => ({ ...e.meta }));
  }

  pids(): { id: string; pid: number | null }[] {
    return [...this.map.values()].map((e) => ({ id: e.meta.id, pid: e.meta.pid }));
  }

  setRam(id: string, ramKB: number | null): void {
    const e = this.map.get(id);
    if (e) e.meta.ramKB = ramKB;
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Best-effort RSS sampling via `ps` (macOS/Linux). Returns KB or null when
 * unavailable (e.g. Windows, or the process already exited).
 */
export function sampleRam(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform === "win32") return resolve(null);
    const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.on("error", () => resolve(null));
    ps.on("close", () => {
      const kb = parseInt(out.trim(), 10);
      resolve(Number.isFinite(kb) ? kb : null);
    });
  });
}
