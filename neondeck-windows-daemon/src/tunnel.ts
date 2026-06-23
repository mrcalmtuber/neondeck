/**
 * Zero-config public tunnel (Feature 4).
 *
 * Wraps `localtunnel`, which opens an outbound connection from THIS machine to
 * the loca.lt relay and forwards public traffic back to a loopback port. Because
 * the relay connects out (not in), it needs no router/firewall changes — a
 * beginner can share a link with a friend instantly.
 *
 * Honesty notes:
 *  - The link is public for as long as the tunnel is open; closing it (or the
 *    daemon exiting) kills the URL.
 *  - localtunnel forwards to 127.0.0.1:<port>, so the app only needs to listen on
 *    loopback (which our dev servers do). It does require outbound internet.
 *  - We import it dynamically so the daemon still builds/runs if it's absent.
 */

export interface TunnelHandle {
  url: string;
  close: () => void;
}

interface LtTunnel {
  url: string;
  close: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

export async function openTunnel(
  port: number,
  onClose: () => void,
): Promise<TunnelHandle> {
  let localtunnel: (opts: { port: number }) => Promise<LtTunnel>;
  try {
    const mod = (await import("localtunnel")) as unknown as {
      default: (opts: { port: number }) => Promise<LtTunnel>;
    };
    localtunnel = mod.default;
  } catch {
    throw new Error(
      "Tunnel provider not installed. Run `npm install localtunnel -w @ide/daemon` and retry.",
    );
  }

  const tunnel = await localtunnel({ port });
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  tunnel.on("close", finish);
  tunnel.on("error", finish);

  return {
    url: tunnel.url,
    close: () => {
      try {
        tunnel.close();
      } catch {
        /* already gone */
      }
      finish();
    },
  };
}
