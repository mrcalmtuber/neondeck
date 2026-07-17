import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Split the heavy third-party libs into their own cacheable chunks (L9) so the
    // ~1.4 MB single bundle stops tripping the 500 kB warning and the app chunk
    // (which changes far more often) stays small.
    rollupOptions: {
      output: {
        manualChunks: {
          firebase: ["firebase/app", "firebase/auth", "firebase/firestore"],
          editor: ["@uiw/react-codemirror", "@codemirror/lang-javascript"],
        },
      },
    },
  },
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
