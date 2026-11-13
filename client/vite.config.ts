// Сборка клиента: `vite build client` из корня репозитория → client/dist.
// Для разработки `vite client` проксирует /api на локальный сервер.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const api = process.env.CHAOS_DAY_API ?? "http://127.0.0.1:3000";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: api, changeOrigin: false } },
  },
});
