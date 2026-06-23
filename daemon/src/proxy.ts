import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";

/**
 * Dynamic multi-container reverse proxy — now mounted ON the daemon's single HTTP
 * server (no separate port) so the whole app fits one PaaS port. Maps path
 * prefixes to per-app loopback ports:
 *
 *   <origin>/previews/<slot>/...  ->  http://127.0.0.1:<port>/...
 *
 * Both HTTP and WebSocket (HMR socket) traffic are proxied, so live reload works
 * through the same origin. The host server decides which requests/upgrades to
 * hand here (those under /previews/); this module just routes + forwards.
 *
 * Sub-path caveat: apps that emit absolute asset URLs (e.g. "/assets/x.js") must
 * be told their base path. For Vite set `base: "/previews/<slot>/"`; for CRA set
 * "homepage". Otherwise assets resolve at the gateway root. Static templates +
 * the blank scaffold use relative URLs and work as-is.
 */
export interface ProxyRouter {
  /** Map a slot to an app port. Returns the public gateway path (/previews/<slot>/). */
  register: (slot: string, targetPort: number) => string;
  unregister: (slot: string) => void;
  /** Handle an HTTP request whose URL is under /previews/. */
  handleRequest: (req: IncomingMessage, res: ServerResponse) => void;
  /** Handle a WS upgrade whose URL is under /previews/ (the dev server's HMR socket). */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
}

export const PREVIEW_PREFIX = "/previews/";

/** Create the preview router. It does not bind a port — the daemon's main HTTP
 *  server dispatches /previews/* requests + upgrades to handleRequest/handleUpgrade. */
export function createProxyRouter(): ProxyRouter {
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
    if (!url.startsWith(PREVIEW_PREFIX)) return null;
    const rest = url.slice(PREVIEW_PREFIX.length);
    const slash = rest.indexOf("/");
    const slot = slash === -1 ? rest : rest.slice(0, slash);
    const targetPort = routes.get(slot);
    if (!targetPort) return null;
    const rewritten = slash === -1 ? "/" : rest.slice(slash);
    return { port: targetPort, rewritten };
  }

  return {
    register(slot, targetPort) {
      routes.set(slot, targetPort);
      console.log(`[proxy] ${PREVIEW_PREFIX}${slot} -> 127.0.0.1:${targetPort}`);
      return `${PREVIEW_PREFIX}${slot}/`;
    },
    unregister(slot) {
      routes.delete(slot);
    },
    handleRequest(req, res) {
      // Canonicalize a bare slot ("/previews/<slot>") to its trailing-slash form
      // so the iframe's relative asset URLs resolve under the slot (otherwise the
      // browser drops the slot and assets 404 -> unstyled page). Belt-and-suspenders
      // for the "Open in new tab" link and any externally-typed URL.
      if (req.url && req.url.startsWith(PREVIEW_PREFIX)) {
        const rest = req.url.slice(PREVIEW_PREFIX.length);
        const q = rest.indexOf("?");
        const pathPart = q === -1 ? rest : rest.slice(0, q);
        if (pathPart && !pathPart.includes("/") && routes.has(pathPart)) {
          const query = q === -1 ? "" : rest.slice(q);
          res.writeHead(301, { location: `${PREVIEW_PREFIX}${pathPart}/${query}` });
          res.end();
          return;
        }
      }
      const match = req.url ? resolve(req.url) : null;
      if (!match) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("No preview mapped for this path.");
        return;
      }
      req.url = match.rewritten;
      proxy.web(req, res, { target: `http://127.0.0.1:${match.port}` });
    },
    handleUpgrade(req, socket, head) {
      const match = req.url ? resolve(req.url) : null;
      if (!match) {
        socket.destroy();
        return;
      }
      req.url = match.rewritten;
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${match.port}` });
    },
    close() {
      proxy.close();
    },
  };
}
