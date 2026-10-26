# Suishengo Agent

随申 GO 独立 AI 后端，拥有 AI 会话、消息、运行和输出事件。业务后端继续拥有用户、票根、权益与核销等业务事实。

当前实现包含身份认证、用户隔离、流式输出、PG 持久化、取消与完整重放，以及模型和 MCP 工具接入机制。外部身份系统、模型、业务工具和 Langfuse 的可用性需分别联调确认；开发工作台与模拟测试通过不代表业务闭环已验收。

Node.js 22.19+、pnpm 10.26、TypeScript。主要技术为 Cordis、Pi、Fastify、AI SDK UI Stream、PostgreSQL / Drizzle 和 Langfuse；依赖版本以 `package.json` 和 lockfile 为准。

## 快速启动

准备 Node.js、pnpm、Docker，在仓库根目录执行。已有 `.env` 时保留自己的配置。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up
pnpm db:migrate
# 填写模型连接与密钥，或在 apps/backend/config.yaml 中设置 model: false
pnpm dev
```

默认端口：backend `4400`、frontend `5188`、PG `5438`。在根目录 `.env` 设置 `AGENT_ACCESS_TOKEN` 后打开 <http://127.0.0.1:5188>，工作台自动连接并加载该凭证所属用户的会话。

`AGENT_ACCESS_TOKEN` 必须是身份签发方提供、符合后端认证契约的访问令牌；`AUTH_SECRET` 是后端验签密钥，两者不能互换。工作台的 Vite 代理读取令牌并附加到 API 请求，浏览器不输入、保存或打包该令牌。当前工作台凭证不设置过期时间；更换用户或轮换凭证时更新配置并重启 frontend；刷新会自动重新连接，选择会话后可手动恢复输出。认证字段要求见[接入说明](docs/integrations.md)。

模型、压缩和执行预算由 [backend/config.yaml](apps/backend/config.yaml) 配置，默认通过 DashScope 调用 `deepseek-v4.1-flash`。启动前在 `.env` 填写 `DASHSCOPE_BASE_URL` 与 `DASHSCOPE_API_KEY`；仅管理会话时将 YAML 的 `model` 设为 `false`。启用能力但缺少必要配置会阻止启动。配置文件修改后重启 backend；其他外部依赖和配置见[接入说明](docs/integrations.md)。

Ctrl+C 停止应用；`pnpm infra:down` 停止本工程 PG，保留数据卷。

## 阅读入口

| 需要完成的事情                               | 文档                                                               |
| -------------------------------------------- | ------------------------------------------------------------------ |
| 理解模块职责、消息执行、运行状态与数据一致性 | [架构设计](docs/architecture.md)                                   |
| 修改代码、生成迁移、选择和执行验证           | [开发约定](docs/development.md)                                    |
| 配置身份、模型、Prompt、Langfuse 和 MCP      | [外部接入](docs/integrations.md)                                   |
| 接入客户端，处理流式响应、取消和重连         | [客户端接入](docs/api/README.md)、[OpenAPI](docs/api/openapi.json) |
| 管理本地 PG 和外部开发依赖                   | [开发环境](deploy/development/README.md)                           |
| 构建镜像、迁移和升级生产服务                 | [生产部署](deploy/production/README.md)                            |
| 让编码代理定位本次任务的规则                 | [AGENTS.md](AGENTS.md)                                             |

## 常用命令

```sh
pnpm check           # 格式、lint、类型、测试与构建
```

真实 PG 集成测试需要专用 `_test` 数据库，准备及执行方法见[开发约定](docs/development.md)。正式部署只运行 backend HTTP 服务；frontend 是开发工作台，eval 是独立验证命令。
