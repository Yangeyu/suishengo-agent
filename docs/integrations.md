# 外部接入

本文用于配置和联调外部系统。变量解析、默认值与组合校验以 [backend config](../apps/backend/src/config.ts) 为准；本地配置从 [.env.example](../.env.example) 开始，生产操作见[生产部署](../deploy/production/README.md)。

## 身份系统

`AUTH_ISSUER` 默认 `suishengo-local`，`AUTH_AUDIENCE` 默认 `suishengo-agent`；外部身份接入按实际签发方覆盖。只配置一个认证来源：

- 对称验签：`AUTH_SECRET`，至少 32 字符，验证身份签发方提供的 HS256 令牌。
- 正式接入：`AUTH_JWKS_URL`，验证 RS256 或 ES256；production 强制 HTTPS JWKS，禁止本地 secret。

JWT 必须包含 `sub`、`iat`，issuer 与 audience 必须匹配；`sub` 为服务端 Actor 的用户标识。浏览器请求体和模型输入不提供可信身份。工作台访问凭证不设置 `exp`，不需要定期续签；如外部签发方提供了 `exp`，标准 JWT 校验仍遵守该声明。

工作台通过根目录 `.env` 中的 `AGENT_ACCESS_TOKEN` 配置访问令牌，Vite 代理在服务端附加 Bearer 请求头。浏览器不持有该配置，不把它作为 `VITE_*` 变量注入构建产物。未配置时代理返回 503；令牌无效时后端返回 401。更新凭证后重启 frontend。工作台不签发身份，也不把任意固定字符串映射为用户。

当前 JWT 的字段和 production 的 JWKS 要求仍需与业务身份系统对齐；不能直接假定现有业务登录令牌符合此契约。业务小程序使用其登录流程取得的用户凭证，不共用工作台的固定凭证。

联调至少使用两个测试用户，验证正常访问、令牌失效及跨用户访问不可见。客户端只使用访问令牌，不持有签名密钥。

## 模型与执行策略

模型接入在 `.env` 中填写 `DASHSCOPE_API_KEY`。[百炼 Provider](../plugins/pi/src/model/providers/bailian.ts) 默认使用北京接口 `https://dashscope.aliyuncs.com/compatible-mode/v1`，其他地域或专属端点通过 `DASHSCOPE_BASE_URL` 指定。地址与密钥必须匹配地域和计费方案，参见 [DashScope 地址说明](https://help.aliyun.com/zh/model-studio/base-url)。

[backend/config.yaml](../apps/backend/config.yaml) 中的模型配置为：

```yaml
model:
  provider: dashscope
  modelId: deepseek-v4.1-flash
  maxOutputTokens: 4096
```

`provider` 和 `modelId` 选择 Provider 目录中的模型，`maxOutputTokens` 设置应用单次输出额度。当前目录支持 `deepseek-v4.1-flash`，声明上下文窗口 131072、输出上限 4096。窗口、reasoning 能力和协议兼容参数由模型定义维护；接入新模型时验证其能力与协议，再加入目录。

启动时校验模型选择、凭据、地址及输出额度。`model: false` 仅启用会话管理，production 要求启用模型。配置来源和运行边界见[架构设计](architecture.md#模块归属)。

上下文压缩和执行预算也在 YAML 中配置：

| 配置                  | 默认行为                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- |
| `context.compaction`  | 触发比例 0.7，优先保留近期 2 轮，摘要上限 1024 tokens；设为 `false` 关闭           |
| `runtime.limits`      | 每轮最多 8 个模型步骤、12 次工具调用、32000 tokens                                 |
| `runtime.concurrency` | 全局最多 8 个运行，每个用户最多 2 个                                               |
| `runtime.timeoutMs`   | 每轮协作超时 120000 毫秒；取消与收尾语义见[状态与恢复](architecture.md#状态与恢复) |

对话和摘要共用模型与运行 token 预算，摘要不调用业务工具。预算不足可提前触发压缩，窗口不足时可减少保留的旧交互。上下文大小使用保守 UTF-8 字节估算；压缩可能损失信息，原始历史保留在数据库。具体算法与持久化规则见[上下文与摘要](architecture.md#上下文与摘要)。

真实模型联调使用有权限的测试密钥，验证文本、reasoning、工具往返、usage 和取消。`pnpm eval` 的运行方式和验证边界见[开发约定](development.md#真实模型冒烟)。

## 配置文件与部署参数

默认读取随应用发布的 `apps/backend/config.yaml`，与进程工作目录无关。`CONFIG_FILE` 可指定另一份完整文件，建议使用绝对路径；相对路径按进程工作目录解析。自定义文件不会与默认文件合并，省略的可选字段按所属契约补默认值。YAML 未知字段和不合法配置会启动失败；修改文件后重启生效。

配置文件按能力分组，插件拥有自身参数约束，应用负责生产认证、远程 Prompt 连接等跨能力校验。执行策略从 YAML 读取，部署参数、环境观测开关和凭据从环境变量读取。`loadConfig` 解析后形成完整对象，插件不查询全局配置服务。迁移命令只读取 `DATABASE_URL`，不加载模型或 HTTP 配置。

| 变量                           | 默认值                               | 用途                                       |
| ------------------------------ | ------------------------------------ | ------------------------------------------ |
| `CONFIG_FILE`                  | 随应用发布的 config.yaml             | 选择完整配置文件                           |
| `NODE_ENV`                     | development                          | 运行环境，生产部署设置为 production        |
| `HOST`                         | 127.0.0.1                            | HTTP 监听地址；容器内为 0.0.0.0            |
| `PORT`                         | 4400                                 | HTTP 监听端口                              |
| `LOG_LEVEL`                    | info                                 | 诊断日志级别                               |
| `TELEMETRY_ENABLED`            | false                                | 是否启用观测 SDK 与 Langfuse 导出          |
| `APP_RELEASE`                  | 无                                   | 观测中的 commit 或镜像版本                 |
| `LANGFUSE_CAPTURE_CONTENT`     | production 为 false，其他环境为 true | 部署环境是否允许采集经过大小限制的输入输出 |
| `LANGFUSE_SHUTDOWN_TIMEOUT_MS` | 10000                                | 观测关闭等待期限，1–25000 毫秒             |

配置文件选择能力及参数，插件依赖与挂载顺序由 `application.ts` 管理。

远程 Prompt 和 MCP 的条件配置见下文。frontend 的 `AGENT_ACCESS_TOKEN` 和 `BACKEND_URL`（默认 `http://127.0.0.1:4400`）、eval 的 `EVAL_BASE_URL` / `EVAL_TOKEN`、集成测试的 `TEST_DATABASE_URL` 分别属于对应入口；生产 Compose 的 `BACKEND_IMAGE` 和可选 `HTTP_PORT` 属于部署配置。

## Prompt 管理与 Langfuse

当前管理产品指令和摘要指令，使用 text 模板。默认内容与变量契约分别见 [backend/agent/prompts.ts](../apps/backend/src/agent/prompts.ts) 和 [context/prompts.ts](../plugins/context/src/prompts.ts)；定义、解析与渲染的职责见[模块归属](architecture.md#模块归属)。

YAML 通过同一绑定结构选择远程来源，未绑定的定义使用模块本地模板：

```yaml
prompts:
  cacheTtlSeconds: 60
  bindings:
    agent.system:
      name: suishengo/agent/system
      version: 2
    context.compaction:
      name: suishengo/context/compaction
      label: production
```

每个绑定的 `version` 与 `label` 必须二选一。未知或未启用模块的 key、重复定义、缺少连接会在组装时失败；远程模板在运行准备阶段读取，获取失败或变量契约不符会令本次运行失败，不回退到本地文案。默认绑定为空，不要求 Langfuse。

每次运行固定实际取得的 Prompt 版本，运行中的标签切换只影响后续解析。SDK 缓存默认 60 秒，过期缓存可在后台刷新期间继续返回旧版本；清单始终记录实际取得的版本。测试和需要即时解析的实验可设置 `cacheTtlSeconds: 0`。需要配套发布时使用显式版本集合，多个独立标签不提供原子发布。

远程模板使用模块声明的 `{{variable}}` 占位符；缺失、额外或不匹配的变量均报错，变量值只替换一次。一个受管理部分构成完整 system 时，generation 使用 Langfuse 原生 Prompt 关联；组合来源记录在 `promptUsage` 中。

摘要模板变更会影响历史摘要复用，规则见[上下文与摘要](architecture.md#上下文与摘要)。启用观测时记录运行级 Prompt 清单和逐次使用来源；PG 保存摘要复用指纹，不保存完整 Prompt 快照或输入复现档案。

Langfuse 连接需要完整的 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY`。观测由 `TELEMETRY_ENABLED` 显式控制，未设置时关闭；本地开发示例设为 `true`，生产示例设为 `false`。开启时必须提供完整连接。关闭时不初始化观测 SDK、不采集正文、不发送观测请求。远程 Prompt 独立使用这组连接，不受观测开关影响；部分连接配置会启动失败。JS/TS SDK 6.0.2 要求 Langfuse v4.59.0 或更高版本，参见[官方兼容说明](https://langfuse.com/docs/observability/sdk/overview)。

Langfuse 按会话和 runId 定位执行记录，调用层级和关联字段见[日志与观测](architecture.md#日志与观测)。generation 包含模型、`modelParameters.max_tokens`、首个内容时间、结束原因和 system 文本哈希；Prompt 关联按上述来源规则记录。环境来自 `NODE_ENV`，发布版本来自可选的 `APP_RELEASE`。

运行预算中的输入 token 数包含缓存读写；观测导出的 `input`、`input_cached_tokens`、`input_cache_write_tokens` 分别表示非缓存输入、缓存读取和缓存写入，另记 `output` 与 `total`。模型返回全零 usage 时标记 `usageAvailable: false`，省略实测 usage；失败或取消也不补零。平台估算与服务商实测需区分，费用计算取决于平台的模型及价格配置。

`LANGFUSE_CAPTURE_CONTENT` 在 development/test 默认开启，在 production 默认关闭。启用观测且开启采集时，记录用户问题、已提交回答、模型消息与工具参数和结果；仅关闭正文采集时保留调用层级和诊断 metadata，包括工具定义中的描述和展示名称。工具说明用于描述能力，不填写凭据或用户数据。输入输出在序列化前屏蔽常见结构化凭据字段，并限制深度、条目数、字符串及总大小；这不等于任意业务正文都已脱敏。原始异常正文和适配器 replay 数据不导出。

导出使用 SDK 的批处理与重试，每次网络请求超时 5 秒。`LANGFUSE_SHUTDOWN_TIMEOUT_MS` 限制关闭时的等待时长；超时或失败记录 `telemetry.shutdown_failed`，SDK 请求可能继续收尾。观测记录失败只产生诊断日志，导出不提供持久化队列或送达保证。

平台联调使用专用测试项目：按 runId 回读 Run、Step、generation 和工具节点，检查父子关系、采集开关、usage 及 Prompt 版本；在对应节点核对 purpose、status、stepId。远程 Prompt 需确认配置的固定版本实际生效。本地 OTLP 接收成功只证明导出协议通过，平台写入和查询需独立验证。开发实例准备见[开发环境](../deploy/development/README.md)。

## 当前会话检索

内置只读工具 `search_current_session` 由 `plugins/tools/src/builtins/search-current-session.ts` 定义。应用向 tools 插件注入 sessions 能力后，由插件组装并默认提供该工具，不需要 MCP 或额外数据库配置。模型只提交 `query` 和可选的 `limit`（默认 5，最多 10）；用户和运行身份来自服务端上下文，不能指定其他用户、会话或运行。

检索由 sessions 存储执行：重新校验运行所有权，只查询当前会话、本轮之前已完成运行中的完整用户正文和助手文本。原始消息即使已被上下文摘要覆盖仍可检索；reasoning、工具参数与结果、SDK 回放信息、失败或取消运行均不作为检索内容。关键词去除首尾空白后进行不区分大小写的连续文本匹配，不做分词、向量或语义搜索。

结果按运行位置和消息顺序从新到旧返回，包含 `messageId`、`runId`、`position`、`role`、`excerpt`、`truncated`；片段最多 1000 字符，并保留命中位置。`hasMore` 表示仍有未返回的匹配。查询使用参数绑定、数据库 2 秒执行上限和工具 5 秒超时，沿用通用工具调用预算、取消与观测。历史消息只说明曾经说过什么，不证明当前票根、权益或其他业务事实。

## MCP 与业务工具

当前已有 MCP Streamable HTTP 客户端及工具执行机制。是否具备可用票根、权益或核销能力，取决于实际业务服务、允许工具和授权契约，不能仅凭插件存在认定业务已接通。

默认 `tools.mcp: false`。启用时将其改为 `allowedTools` 列表，例如：

```yaml
tools:
  mcp:
    allowedTools: [search_places, get_place_detail]
```

列表使用经确认的远端工具名，并完整提供以下环境变量：

| 变量                | 来源与用途                                         |
| ------------------- | -------------------------------------------------- |
| `MCP_URL`           | 业务方提供的 MCP 地址，production 必须 HTTPS       |
| `MCP_SERVICE_TOKEN` | 访问 MCP 服务的服务端凭证                          |
| `MCP_ACTOR_SECRET`  | 本服务与业务方约定的身份断言签名密钥，至少 32 字符 |
| `MCP_AUDIENCE`      | 业务服务校验身份断言的 audience                    |

每次运行创建独立 MCP 客户端。这是项目自定义的服务间身份契约，并非 MCP OAuth。出站请求携带服务 Bearer 凭证，以及 `x-agent-actor` 中的短期 HS256 JWT：issuer 为 `suishengo-agent`，subject 来自已验证用户，包含 runId、sessionId，有效期 60 秒。业务方需要校验签名、issuer、audience、时效，并再次检查工具及业务资源权限。

允许工具名必须在远端目录中存在；模型看到的名称增加 `mcp_` 前缀。通用工具执行检查输入 schema、授权、调用次数和输出大小，按工具超时执行，不自动重试副作用。

当前 MCP 映射把允许工具声明为 read，没有实现用户核销确认流程。配置方只应开放已经人工确认的只读工具，不把远端 annotations 视为授权依据；业务写操作接入前，需明确其副作用、用户确认、幂等及失败后的业务状态，不能把允许列表当成完整授权模型。

联调分别确认：服务认证、用户身份委托、允许目录、参数验证、成功结果、无权限、超时和取消。`/api/capabilities` 的 `businessTools` 只反映业务工具配置存在，不包含内置会话检索，也不表示远端可用或业务验收通过。
