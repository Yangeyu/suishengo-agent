# Suishengo Agent

随申 GO 独立 AI 后端。当前交付文本会话的工程基础：身份认证、用户隔离、流式输出、PG 持久化、取消与重放。业务后端继续拥有用户、票根和权益事实。

Node.js 22.19+、pnpm 10.26、TypeScript；Cordis 组装、Pi 执行模型调用、Fastify HTTP、AI SDK UI 消息协议、PostgreSQL + Drizzle、Langfuse SDK。具体依赖版本由 lockfile 固定。

## 开发启动

需要 Node.js、pnpm、Docker。默认端口为 backend `4400`、frontend `5188`、PG `5438`。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up
pnpm db:migrate
pnpm dev
```

打开 <http://127.0.0.1:5188>，另开终端生成本地用户令牌，粘贴到工作台：

```sh
pnpm dev:token developer-a
```

开发令牌有效期两小时，换用 `developer-b` 可验证用户隔离。令牌仅保存在页面内存，刷新后重新连接。生产认证使用业务身份系统的 HTTPS JWKS；HS256 本地令牌在 production 下禁用。

没有模型配置时，仍可连接工作台和管理会话，发送入口显示未配置。要调用真实模型，在 `.env` 中同时设置 `MODEL_BASE_URL`、`MODEL_ID`、`MODEL_API_KEY`，重启后端。当前适配 OpenAI-compatible Chat Completions，输出上限 2048 tokens，最近十轮完成对话作为历史。不同厂商的兼容性需实际联调。

停止应用使用 Ctrl+C；停止本工程 PG 使用 `pnpm infra:down`，不会删除数据卷。

## 目录与阅读路径

```text
apps/
  backend/src/
    main.ts              # 进程启动与信号处理
    config.ts            # 环境配置校验
    application.ts       # Cordis 组装和关闭顺序
    migrate.ts           # 独立迁移命令
    http/                # 认证、路由、PG 事件到 HTTP 流
      __tests__/         # HTTP 认证契约
    agent/prompts.ts     # 申申的产品 Prompt
  frontend/src/          # React 开发工作台
  eval/src/              # HTTP 冒烟评测入口
packages/
  harness/src/           # Model、Sessions、Telemetry 能力契约
  runtime/src/           # 执行、取消、超时、关闭
  chat-protocol/src/     # UIMessage、事件和 HTTP 数据类型
plugins/
  pi/src/                # 每次运行创建独立 Agent
    __tests__/           # 模型协议契约
  sessions-pg/           # Store、Drizzle schema、migrations
  prompts/src/           # 本地或固定 Langfuse 版本的 Prompt
  telemetry/src/         # 运行状态与 Langfuse trace
deploy/
  backend.Dockerfile     # backend 生产镜像
  development/           # 本地 PG 与可选 Langfuse 说明
  production/            # 仅 backend 服务的部署配置
scripts/
  build-backend.mjs      # 清理、编译、别名处理、复制迁移资源
  dev-token.ts           # 本地开发令牌
tests/
  integration/           # 真实 PG + HTTP 集成验证
```

一条消息的执行路径：

```text
POST /api/chat
  → 验证 JWT，取得用户身份
  → runtime.submit
  → sessions.admit：检查所有权、幂等、会话并发、用户额度
  → 同事务写入 run、用户消息、assistant 消息和初始事件
  → Pi Agent 使用服务端历史调用模型
  → 每段输出同事务更新 assistant 消息、追加事件
  → HTTP 读取已提交事件，用 AI SDK UI Stream 返回
  → 运行结束写终态；工作台可再次读取历史或重放
```

数据库 migrations 与存储实现同属 `sessions-pg`。业务 Prompt 改动落在 backend/agent；模型协议变动落在 pi；身份校验在 HTTP 层；并发策略在 runtime/store。

`packages` 与 `plugins` 是源码模块目录，由根工程管理依赖和构建，不声明独立 workspace 包。workspace 只保留 backend 开发命令入口和拥有独立前端依赖、构建的 frontend；eval 由根命令直接执行。

项目内部导入使用 `@backend/...`、`@frontend/...`、`@plugins/...`、`@harness`、`@runtime` 和 `@protocol`，源码模块路径不写 `.js` 后缀。TypeScript 使用 `ESNext` + `Bundler` 解析源码。后端构建统一输出到根目录 `dist`，通过 `tsc-alias` 将别名转换为相对路径并补齐 Node ESM 所需的 `.js` 后缀；生产运行必须使用完整的 `pnpm build:backend` 产物。前端由 Vite 解析别名；CSS 等资源保留实际文件后缀。

## 多用户与执行语义

- 会话绑定 JWT `sub`。读取历史、发送消息、查询运行、重放和取消都校验所有权，跨用户返回 404。
- 用户/全局额度在 PG 短事务锁内判断，同一会话只允许一个活跃运行；不同会话与用户可并发。默认每用户 2 个、全局 8 个。
- 同一会话的 `requestId` 是幂等键，重复内容返回同一个 run；同键不同内容返回 409。
- 每个 run 有独立 Agent、历史和 AbortController。Cordis 服务与连接池按进程共享。
- 断开流只停止订阅，显式取消调用 `/api/runs/:id/cancel`。事件持久化，重放返回该 run 的完整流；客户端需替换此前的部分 assistant 消息。
- 首版采用单个执行实例，可同时服务多用户。数据库 advisory lock 阻止重复实例启动；进程崩溃后的运行标记为 interrupted，不自动重新调用模型。尚不支持多副本、持久任务队列或不中断滚动更新。
- 当前是用户隔离模型，没有组织租户、共享会话或管理员跨用户查询。后续引入组织权限时需独立定义 tenant/member 契约。

## HTTP 契约

除健康检查外需要 `Authorization: Bearer ...`。开发前端通过 Vite 同源代理访问服务。

| 方法与路径 | 用途 |
| --- | --- |
| GET `/health/live`、`/health/ready` | 进程存活与运行入口状态；不代表外部模型/Langfuse 联通 |
| GET `/api/capabilities` | 是否配置模型、协议版本 |
| GET / POST `/api/sessions` | 当前用户的会话列表 / 创建 |
| GET `/api/sessions/:id` | 消息快照与当前活跃运行 |
| POST `/api/chat` | 创建或重放运行，返回 SSE |
| GET `/api/runs/:id` | 运行状态 |
| GET `/api/runs/:id/stream` | 完整事件流重放 |
| POST `/api/runs/:id/cancel` | 显式取消 |

`POST /api/chat` 只接受一条用户文本消息，不信任浏览器提供的身份、system Prompt 或完整历史：

```json
{
  "sessionId": "<UUID>",
  "requestId": "<UUID>",
  "message": {
    "id": "<UUID>",
    "role": "user",
    "parts": [{ "type": "text", "text": "你好" }]
  }
}
```

正常 JSON 接口使用 HTTP 状态码，错误结构为 `{ "error": { "code": "...", "message": "..." } }`。对话使用 [AI SDK UI Stream 协议](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)，并通过 `x-run-id` 返回运行标识。

## Langfuse 与业务工具

线上 Langfuse 已由外部提供，本工程只配置 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`。缺省全部留空可进行本地开发；配置不完整会启动失败。

当前观测只发送运行标识、会话标识、状态和耗时，不上传对话内容，不包含完整 generation/tool 追踪。可选设置 `LANGFUSE_PROMPT_NAME` 与固定 `LANGFUSE_PROMPT_VERSION`，启动时读取 text Prompt；指定远程 Prompt 后获取失败会阻止启动。

本地自行启动 Langfuse 的方式见 [开发环境说明](deploy/development/README.md)。SDK 6.x 的版本选择基于初始化时可用版本，接入现有线上服务前必须核对服务版本与 SDK 兼容性，并验证 trace 写入和 Prompt 读取。

票根/MCP 工具尚未实现：需要业务方提供 URL、身份委托、工具 schema 和授权边界。后续由 backend/agent 拥有工具语义，插件提供 HTTP/MCP 客户端；可信用户身份由服务端注入，业务后端再次授权。图片上传、权益查询、核销确认及质量评测需随真实业务契约实现，不用演示数据冒充。

## 构建、迁移与验证

```sh
pnpm check
pnpm db:generate     # 修改 schema 后生成迁移，审阅生成的 SQL 再提交
pnpm db:migrate      # 应用已有迁移
pnpm build:backend
pnpm start
pnpm build:frontend
```

真实 PG 集成验证需要专用 `_test` 数据库，测试会清空该库的会话数据。首次创建后再执行：

```sh
docker compose -f deploy/development/compose.yaml exec -T postgres createdb -U suishengo suishengo_agent_test
TEST_DATABASE_URL=postgresql://suishengo:local-development@127.0.0.1:5438/suishengo_agent_test pnpm test:integration
```

集成测试覆盖两用户隔离、幂等、并发额度、独立取消、AI SDK 解析、重放及重启恢复。模型输出由测试夹具提供；另有 Pi 到模拟 OpenAI HTTP 服务的协议验证。

模块测试就近放在所属模块的 `__tests__`，由 `pnpm test` 统一发现；跨模块测试集中放在根目录 `tests/integration`。测试参与类型检查，但不进入生产构建产物。

配置真实模型后，可设置 `EVAL_TOKEN` 与可选 `EVAL_BASE_URL` 执行 `pnpm eval`。它会创建评测会话并调用模型，验证运行完成及流终止，不对业务答案质量打分。

镜像构建与正式环境操作见 [生产部署说明](deploy/production/README.md)。
