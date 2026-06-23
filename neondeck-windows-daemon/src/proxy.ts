import http from "node:http";
import httpProxy from "http-proxy";

/**
 * Dynamic multi-container reverse proxy.
 *
 * Exposes ONE stable gateway port on the host (default 9000) and maps path
 * prefixes to per-container loopback ports:
 *
 *   http://localhost:9000/previews/<slot>/...  ->  http://127.0.0.1:<port>/...
 *
 * Both HTTP and WebSocket (HMR socket) traffic are proxied, so live reload
 * works through the gateway.
 *
 * Sub-path caveat: apps that emit absolute asset URLs (e.g. "/assets/x.js")
 * must be told their base path. For Vite set `base: "/previews/<slot>/"`; for
 * CRA set "homepage". Otherwise assets resolve at the gateway root. This is the
 * standard limitation of prefix-based reverse proxying.
 */
export interface ProxyRouter {
  /** The port actually bound (after collision scan). */
  readonly port: number;
  /** Map a slot to a container port. Returns the public gateway path. */
  register: (slot: string, targetPort: number) => string;
  unregister: (slot: string) => void;
  close: () => void;
}

const PREFIX = "/previews/";

/**
 * Start the proxy. If `preferredPort` is busy, scan upward (up to +50) for the
 * next free port so the daemon never fails to boot on a port collision.
 *
 * `host` is the interface the gateway binds (default loopback). Pass the daemon's
 * bind host (e.g. 0.0.0.0) so external users on a headless node can reach previews.
 */
export async function startProxyAuto(preferredPort: number, host = "127.0.0.1"): Promise<ProxyRouter> {
  for (let port = preferredPort; port < preferredPort + 50; port++) {
    try {
      return await tryStartProxy(port, host);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.warn(`[proxy] port ${port} busy, trying ${port + 1}…`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[proxy] no free port in range ${preferredPort}-${preferredPort + 50}`);
}

function tryStartProxy(port: number, host: string): Promise<ProxyRouter> {
  return new Promise((resolve, reject) => {
    const router = startProxy(port, host);
    const server = router._server;
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      router.close();
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(router);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

export function startProxy(port: number, host = "127.0.0.1"): ProxyRouter & { _server: http.Server } {
  const routes = new Map<string, number>(); // slot -> target port
  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

  proxy.on("error", (err, _req, res) => {
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Preview not reachable yet: ${err.message}`);
    }
  });

  /** Pull the slot out of /previews/<slot>/rest and rewrite req.url to /rest. */
  function resolve(url: string): { port: number; rewritten: string } | null {
    if (!url.startsWith(PREFIX)) return null;
    const rest = url.slice(PREFIX.length);
    const slash = rest.indexOf("/");
    const slot = slash === -1 ? rest : rest.slice(0, slash);
    const targetPort = routes.get(slot);
    if (!targetPort) return null;
    const rewritten = slash === -1 ? "/" : rest.slice(slash);
    return { port: targetPort, rewritten };
  }

  const server = http.createServer((req, res) => {
    const match = req.url ? resolve(req.url) : null;
    if (!match) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("No preview mapped for this path.");
      return;
    }
    req.url = match.rewritten;
    proxy.web(req, res, { target: `http://127.0.0.1:${match.port}` });
  });

  // Proxy the dev server's HMR / app WebSocket through the same gateway.
  server.on("upgrade", (req, socket, head) => {
    const match = req.url ? resolve(req.url) : null;
    if (!match) {
      socket.destroy();
      return;
    }
    req.url = match.rewritten;
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${match.port}` });
  });

  server.on("listening", () => {
    console.log(`[proxy] gateway listening on http://${host}:${port}${PREFIX}<slot>`);
  });
  server.listen(port, host);

  return {
    _server: server,
    port,
    register(slot, targetPort) {
      routes.set(slot, targetPort);
      console.log(`[proxy] ${PREFIX}${slot} -> 127.0.0.1:${targetPort}`);
      return `${PREFIX}${slot}`;
    },
    unregister(slot) {
      routes.delete(slot);
    },
    close() {
      proxy.close();
      server.close();
    },
  };
}
