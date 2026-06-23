import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Static file server for the built web SPA (web/dist), so the daemon can serve
 * the frontend, the API, the WebSocket, and the live-preview gateway all on ONE
 * port — the shape a single-service PaaS deploy needs.
 *
 * Returns null when the directory doesn't exist (e.g. local dev, where Vite on
 * :5173 serves the web instead). The caller then just 404s non-API/non-preview
 * routes, leaving local dev untouched.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export type WebHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** Build a static handler rooted at `webDir`, or null if the dir is missing. */
export function makeWebHandler(webDir: string): WebHandler | null {
  const root = path.resolve(webDir);
  if (!fs.existsSync(path.join(root, "index.html"))) return null;

  const indexHtml = path.join(root, "index.html");

  function serveFile(res: ServerResponse, file: string): void {
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] ?? "application/octet-stream";
    // Hashed assets are immutable; index.html must always re-validate.
    const cache = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
    res.writeHead(200, { "content-type": type, "cache-control": cache });
    fs.createReadStream(file).pipe(res);
  }

  return (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let file = path.join(root, urlPath);
      // Path-traversal guard: stay inside root.
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("Forbidden");
      }
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
      // SPA fallback: any unmatched route serves index.html (client-side routing).
      return serveFile(res, indexHtml);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("500 " + (err as Error).message);
    }
  };
}
