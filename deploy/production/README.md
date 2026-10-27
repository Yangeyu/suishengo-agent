# 生产部署

交付物是一个 backend HTTP 镜像。PG、身份系统、模型服务由外部提供；按需使用外部 Langfuse；前端工作台和 eval 不部署到正式环境。

在仓库根目录构建并发布到团队镜像仓库：

```sh
docker build -f deploy/backend.Dockerfile -t suishengo-agent:0.1.0 .
```

构建默认使用 npm 官方源；如构建环境通过团队镜像源访问 npm，可传入 `--build-arg NPM_REGISTRY=<registry URL>`，仍使用 frozen lockfile 和包完整性校验。该参数只用于构建，不写入运行镜像配置。

发布镜像由团队的 CI/镜像仓库流程负责。运行环境准备配置：

```sh
cp deploy/production/.env.example deploy/production/.env
cp apps/backend/config.yaml deploy/production/config.yaml
```

将 `BACKEND_IMAGE` 替换为实际镜像（正式发布建议 digest）；填写外部 PG、HTTPS JWKS、`DASHSCOPE_API_KEY`（需要其他地域或专属端点时另填 `DASHSCOPE_BASE_URL`）。生产默认 `TELEMETRY_ENABLED=false`，不启动观测 SDK；需要观测时设置为 `true` 并填写完整 Langfuse 连接。只使用远程 Prompt 时可保持观测关闭，填写同一组连接参数。`config.yaml` 配置模型、压缩、运行预算、MCP 和远程 Prompt；Compose 将其只读挂载到 `/app/config.yaml` 并通过 `CONFIG_FILE` 指定。修改后重新创建 backend 容器生效，升级时审阅并同步配置与代码契约。字段说明和外部服务版本要求见[外部接入](../../docs/integrations.md)。

首次部署执行迁移，通过后启动 HTTP。升级时先备份数据库并停止旧实例，再执行以下命令；当前使用单执行实例，不支持多副本滚动发布。

```sh
# 升级已有服务时先停止旧实例
docker compose --env-file deploy/production/.env -f deploy/production/compose.yaml stop backend
docker compose --env-file deploy/production/.env -f deploy/production/compose.yaml run --rm --no-deps backend node dist/apps/backend/src/migrate.js
docker compose --env-file deploy/production/.env -f deploy/production/compose.yaml up -d --wait
```

镜像运行身份为 node，只有生产依赖与编译代码；迁移文件与默认配置随镜像分发；直接运行镜像时默认读取内置配置，自定义文件需挂载并设置 `CONFIG_FILE`，HTTP 启动不执行迁移。

收到 SIGTERM/SIGINT 后，服务停止接纳、等待接纳事务、取消并等待活跃运行，然后关闭 HTTP 和插件。进程整体退出期限为 30 秒，Compose 停止宽限期为 35 秒。Langfuse 关闭等待由 `LANGFUSE_SHUTDOWN_TIMEOUT_MS` 控制，超时后 SDK 网络请求可能继续收尾；该等待期限包含在整体退出期限内。

生产网关负责 HTTPS 和入口治理；转发 SSE 时关闭响应缓冲，读取超时需大于 `runtime.timeoutMs`，透传认证头。默认 HTTP 端口只绑定回环地址，按实际网关部署调整网络。

生产联调需要分别验证业务身份签发、模型流式响应、业务工具授权，以及已启用的 Langfuse 写入或远程 Prompt 读取，具体见[外部接入](../../docs/integrations.md)。发布验收还需确认容量、监控告警及业务场景。
