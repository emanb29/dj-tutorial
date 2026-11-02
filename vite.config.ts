import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadEnvFile, requirePublicHosts, requireServerConfig } from "./server/config.ts";

// Cross-origin isolation enables SharedArrayBuffer for the analysis threads, while
// `credentialless` still allows CORS-enabled audio from Audius and archive.org (ADR 0001).
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

// For remote access, a reverse proxy or tunnel forwards each of PUBLIC_HOSTS (in .env) to 127.0.0.1:5179.
loadEnvFile();
const allowedHosts = [...requirePublicHosts(process.env)];

const api = requireServerConfig(process.env);
const proxy = { "/api": { target: `http://${api.host}:${String(api.port)}` } };

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    allowedHosts,
    headers: crossOriginIsolationHeaders,
    proxy,
    // Keep Vite from scanning or watching the throwaway prototypes and spikes, and the agents'
    // worktrees under .claude/: a new worktree's tsconfig.json made Vite fully reload the open app.
    watch: { ignored: ["**/prototypes/**", "**/spikes/**", "**/.claude/**"] },
  },
  preview: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    allowedHosts,
    headers: crossOriginIsolationHeaders,
    proxy,
  },
  // onnxruntime-web finds its WASM threads relative to its own module, which pre-bundling breaks.
  optimizeDeps: { entries: ["index.html"], exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
});
