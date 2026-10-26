# 外部接入

本文用于配置和联调外部系统。变量解析、默认值与组合校验以 [backend config](../apps/backend/src/config.ts) 为准；本地配置从 [.env.example](../.env.example) 开始，生产操作见[生产部署](../deploy/production/README.md)。

## 身份系统

必填 `AUTH_ISSUER`、`AUTH_AUDIENCE`，并且只配置一个认证来源：

- 本地开发：`AUTH_SECRET`，至少 32 字符；通过 `pnpm dev:token <用户标识>` 生成 HS256 令牌。
- 正式接入：`AUTH_JWKS_URL`，验证 RS256 或 ES256；production 强制 HTTPS JWKS，禁止本地 secret。

JWT 必须包含 `sub`、`exp`、`iat`，issuer 与 audience 必须匹配；`sub` 为服务端 Actor 的用户标识。浏览器请求体和模型输入不提供可信身份。

联调至少使用两个测试用户，验证正常访问、令牌失效及跨用户访问不可见。客户端只持有访问令牌，不持有签名密钥。

## 模型与执行预算

`MODEL_BASE_URL`、`MODEL_ID`、`MODEL_API_KEY` 成组配置。开发环境可全部留空，production 必须配置完整。

`MODEL_CONTEXT_WINDOW`（默认 128000）和 `MODEL_OUTPUT_TOKENS`（默认 2048）需按实际模型设置。上下文最终检查使用保守 UTF-8 字节估算；不要把默认窗口当成服务商能力探测结果。

默认启用上下文压缩，可用 `CONTEXT_COMPACTION=false` 关闭。`CONTEXT_TRIGGER_FRACTION=0.7` 指窗口触发比例，`CONTEXT_KEEP_RECENT_TURNS=2` 指优先保留的近期完整交互，`CONTEXT_SUMMARY_TOKENS=1024` 为摘要输出上限。运行预算不足时会提前触发压缩；硬窗口压力下可进一步减少保留的旧交互。当前摘要使用同一配置模型，独立标记为 compaction 调用，不使用业务工具。

运行 token 消耗包含对话与摘要。压缩并不保证事实无损，需要使用实际模型评估摘要质量；原始历史始终保留。执行与持久化语义见[架构设计](architecture.md)。

当前 Pi 适配 OpenAI-compatible Chat Completions，输入为文本和内部工具消息，单次生成输出上限 2048 tokens。模型配置中的上下文窗口是适配器声明，不代表已经验证所有厂商的真实能力。历史选择和持久化语义见[架构设计](architecture.md)。

| 变量                   | 默认值 | 作用                                 |
| ---------------------- | ------ | ------------------------------------ |
| `MAX_CONCURRENT_RUNS`  | 8      | 全局活跃运行上限                     |
| `MAX_USER_RUNS`        | 2      | 每用户活跃运行上限                   |
| `RUN_TIMEOUT_MS`       | 120000 | 单次运行超时                         |
| `AGENT_MAX_STEPS`      | 8      | 模型步骤预算                         |
| `AGENT_MAX_TOOL_CALLS` | 12     | 工具调用预算                         |
| `AGENT_MAX_TOKENS`     | 32000  | 基于模型报告 usage 的运行 token 预算 |
| `LOG_LEVEL`            | info   | 诊断日志级别                         |

不同模型的文本流、工具调用格式、usage 和取消表现需实际联调。先验证文本对话，再验证允许的工具调用；`pnpm eval` 只完成 HTTP 冒烟，不证明业务答案质量。预算也不替代模型供应商的计费或额度控制。

## 产品 Prompt 与 Langfuse

产品 Prompt 默认来自 [backend/agent/prompts.ts](../apps/backend/src/agent/prompts.ts)。设置 `LANGFUSE_PROMPT_NAME` 和正整数 `LANGFUSE_PROMPT_VERSION` 后，在启动时加载固定版本的 text Prompt；远程读取失败会阻止启动。

Langfuse 使用 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`，三者全部留空表示不启用外部观测；部分配置会启动失败。远程 Prompt 还要求完整的 Langfuse 连接配置。

观测覆盖 agent.run、每次模型生成 model.generate 和工具执行 tool.execute，记录父子 span、状态与耗时。观测调用不主动传入对话全文或工具输入输出。是否成功写入既有平台，必须核对部署服务与锁定 SDK 的兼容性，并在平台回读对应 runId 的 trace。配置存在或日志输出不代表 Langfuse 已接收数据。

开发实例准备见[开发环境](../deploy/development/README.md)。验证远程 Prompt 时创建测试 text Prompt 并固定版本，启动服务后确认该版本实际生效；不要把最新标签当成固定版本。

## MCP 与业务工具

当前已有 MCP Streamable HTTP 客户端及工具执行机制。是否具备可用票根、权益或核销能力，取决于实际业务服务、允许工具和授权契约，不能仅凭插件存在认定业务已接通。

启用 MCP 时以下配置须完整提供：

| 变量                | 来源与用途                                         |
| ------------------- | -------------------------------------------------- |
| `MCP_URL`           | 业务方提供的 MCP 地址，production 必须 HTTPS       |
| `MCP_ALLOWED_TOOLS` | 经确认的远端工具名，逗号分隔                       |
| `MCP_SERVICE_TOKEN` | 访问 MCP 服务的服务端凭证                          |
| `MCP_ACTOR_SECRET`  | 本服务与业务方约定的身份断言签名密钥，至少 32 字符 |
| `MCP_AUDIENCE`      | 业务服务校验身份断言的 audience                    |

每次运行创建独立 MCP 客户端。这是项目自定义的服务间身份契约，并非 MCP OAuth。出站请求携带服务 Bearer 凭证，以及 `x-agent-actor` 中的短期 HS256 JWT：issuer 为 `suishengo-agent`，subject 来自已验证用户，包含 runId、sessionId，有效期 60 秒。业务方需要校验签名、issuer、audience、时效，并再次检查工具及业务资源权限。

允许工具名必须在远端目录中存在；模型看到的名称增加 `mcp_` 前缀。通用工具执行检查输入 schema、授权、调用次数和输出大小，按工具超时执行，不自动重试副作用。

当前 MCP 映射把允许工具声明为 read，没有实现用户核销确认流程。配置方只应开放已经人工确认的只读工具，不把远端 annotations 视为授权依据；业务写操作接入前，需明确其副作用、用户确认、幂等及失败后的业务状态，不能把允许列表当成完整授权模型。

联调分别确认：服务认证、用户身份委托、允许目录、参数验证、成功结果、无权限、超时和取消。`/api/capabilities` 的 `businessTools` 只反映工具配置存在，不表示远端可用或业务验收通过。
