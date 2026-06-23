import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 loopback explicitly. Vite's default ("localhost") resolves to
    // IPv6 [::1] on macOS, while `localhost` also maps to 127.0.0.1 — that
    // dual-stack split makes Safari stall for seconds before falling back.
    // Pinning to 127.0.0.1 (matching the daemon + WebSocket) loads instantly.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
