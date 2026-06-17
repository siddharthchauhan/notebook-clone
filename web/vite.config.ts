import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the REST contents API and the notebook WebSocket to the
// FastAPI server on :8000, so the browser only ever talks to :5173 (no CORS
// dance during development, and WS upgrades are forwarded transparently).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
    },
  },
});
