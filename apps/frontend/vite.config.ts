import { defineConfig, loadEnv, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("../../", import.meta.url)), [
    "BACKEND_URL",
    "AGENT_ACCESS_TOKEN",
  ]);
  const target = env.BACKEND_URL?.trim() || "http://127.0.0.1:4400";
  const token = env.AGENT_ACCESS_TOKEN?.trim();

  // 代理携带访问凭证，只接受回环地址的同源请求。
  const access: Connect.NextHandleFunction = (request, response, next) => {
    if (!request.url?.startsWith("/api")) return next();

    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (
      !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
      (origin && origin !== "http://" + host)
    ) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "FORBIDDEN", message: "请求来源无效" } }));
      return;
    }

    if (!token) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "WORKBENCH_NOT_CONFIGURED",
            message: "工作台尚未配置访问凭证",
          },
        }),
      );
      return;
    }

    next();
  };

  return {
    plugins: [
      react(),
      {
        name: "workbench-access",
        configureServer(server) {
          server.middlewares.use(access);
        },
        configurePreviewServer(server) {
          server.middlewares.use(access);
        },
      },
    ],
    resolve: {
      alias: {
        "@frontend": fileURLToPath(new URL("./src", import.meta.url)),
        "@harness": fileURLToPath(new URL("../../packages/harness/src", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5188,
      strictPort: true,
      proxy: {
        "/api": {
          target,
          changeOrigin: false,
          headers: { authorization: "Bearer " + token },
        },
        "/health": { target, changeOrigin: false },
      },
    },
  };
});
