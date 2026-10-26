import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@frontend": fileURLToPath(new URL("./src", import.meta.url)),
      "@protocol": fileURLToPath(new URL("../../packages/chat-protocol/src/index.ts", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1", port: 5188, strictPort: true,
    proxy: {
      "/api": { target: process.env.BACKEND_URL ?? "http://127.0.0.1:4400", changeOrigin: false },
      "/health": { target: process.env.BACKEND_URL ?? "http://127.0.0.1:4400", changeOrigin: false },
    },
  },
});
