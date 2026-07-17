import net from "node:net";

/**
 * Preview port pool.
 *
 * Each running preview gets its OWN port so multiple previews can run at once
 * (different users, or the same daemon serving several apps) and a stale/orphaned
 * server can never shadow a new one — the old "every project shows the same app"
 * bug. The daemon owns the port end to end; the client only ever uses the proxy
 * slot URL, so it never needs to know the number.
 */

const RANGE_START = 3001;
const RANGE_END = 3999;

/** Ports currently handed out (released on stopPreview / disconnect). */
const usedPorts = new Set<number>();

/** True if nothing is currently listening on 127.0.0.1:port (orphans fail this). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Reserve a free preview port. Skips ports already handed out and bind-tests each
 * candidate so an orphan still holding a port is stepped over. Throws only if the
 * whole range is exhausted.
 */
export async function allocatePreviewPort(): Promise<number> {
  for (let p = RANGE_START; p <= RANGE_END; p++) {
    if (usedPorts.has(p)) continue;
    // M15 (TOCTOU): reserve the port SYNCHRONOUSLY before the async bind-test, so
    // a second concurrent allocatePreviewPort() sees it in usedPorts and skips it
    // instead of racing onto the same port between the check and the reserve. If
    // the bind-test then fails (an orphan already holds it), un-reserve and move
    // on — a truly free port is never handed out twice.
    usedPorts.add(p);
    if (await isPortFree(p)) return p;
    usedPorts.delete(p);
  }
  throw new Error("No free preview port available (3001–3999 all in use).");
}

/** Return a port to the pool. Safe to call with null/0/undefined. */
export function releasePreviewPort(port: number | null | undefined): void {
  if (port) usedPorts.delete(port);
}
