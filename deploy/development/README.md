# 开发环境

`compose.yaml` 只启动本工程的 PG，使用独立项目名、端口 5438 和数据卷。根目录 `.env` 供 backend、迁移、frontend 代理与 eval 使用。工作台代理从中读取 `AGENT_ACCESS_TOKEN`，为 `/api` 请求附加访问凭证；默认连接 4400，改端口时通过 `BACKEND_URL` 配置。更换访问凭证后重启 frontend。

Langfuse 是可选的外部开发依赖。可以连接已有测试实例，或者按照 [Langfuse 官方 Docker Compose 指南](https://langfuse.com/self-hosting/deployment/docker-compose)，在独立目录启动自己的实例。先根据线上服务版本选择对应 release，配置本地密钥并检查端口占用，不复用业务 PG 数据库。

自行启动后，在 Langfuse 创建项目和 API keys，将地址及 keys 填到本工程 `.env` 的三个 `LANGFUSE_*` 连接字段。运行一次真实对话后，在平台确认 trace 与 runId 对应；需要远程 Prompt 时创建 text Prompt，并配置固定版本后重启。

Langfuse 的 web/worker、ClickHouse、Redis 和对象存储属于它自己的部署。本工程没有复制维护这套平台，也不会在生产配置中启动它。关闭本工程开发 PG 不会影响其他项目或 Langfuse 实例。
