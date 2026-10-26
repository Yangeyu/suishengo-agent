# 生产部署

交付物是一个 backend HTTP 镜像。PG、身份系统、模型服务与已有 Langfuse 都由外部提供；前端工作台和 eval 不部署到正式环境。

在仓库根目录构建并发布到团队镜像仓库：

```sh
docker build -f deploy/backend.Dockerfile -t suishengo-agent:0.1.0 .
```

构建默认使用 npm 官方源；如构建环境通过团队镜像源访问 npm，可传入 `--build-arg NPM_REGISTRY=<registry URL>`，仍使用 frozen lockfile 和包完整性校验。该参数只用于构建，不写入运行镜像配置。

发布镜像由团队的 CI/镜像仓库流程负责。运行环境准备配置：

```sh
cp deploy/production/.env.example deploy/production/.env
```

将 `BACKEND_IMAGE` 替换为实际镜像（正式发布建议 digest）；填写外部 PG、HTTPS JWKS、模型配置和既有 Langfuse 连接信息。迁移以独立一次性命令执行，通过后启动 HTTP：

```sh
docker compose --env-file deploy/production/.env -f deploy/production/compose.yaml run --rm --no-deps backend node dist/apps/backend/src/migrate.js
docker compose --env-file deploy/production/.env -f deploy/production/compose.yaml up -d --wait
```

Compose 中只有 `backend` 服务，没有 PG、前端或 Langfuse。镜像运行身份为 node，只有生产依赖与编译代码；迁移文件随镜像分发，HTTP 启动不执行迁移。

当前只有一个执行实例：升级先停止旧实例，再启动新实例，不使用多副本滚动发布。停止时先拒绝新运行并取消当前运行，再关闭连接和插件。生产网关负责 HTTPS 和入口治理；转发 SSE 时关闭响应缓冲，读取超时需大于 `RUN_TIMEOUT_MS`，透传认证头。默认 HTTP 端口只绑定回环地址，按实际网关部署调整网络。

生产联调需要分别验证业务身份签发、模型流式响应、业务工具授权、Langfuse 写入与固定 Prompt 读取，具体见[外部接入](../../docs/integrations.md)。本地或模拟测试不代表线上服务联通，也不代表容量、监控告警和业务验收完成。当前仅支持单执行实例。
