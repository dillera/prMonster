import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Web app lives in src/web; the Hono server owns /api on :8787.
// `npm run build` emits the client into dist/web, which the server serves
// statically in production.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // SSE note: /api/events is a long-lived text/event-stream response.
      // Vite's http-proxy streams responses through untouched, so no extra
      // buffering configuration is needed; keep `ws: false` and do NOT add any
      // response-rewriting middleware for /api or the stream will stall.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        ws: false,
      },
    },
  },
});
