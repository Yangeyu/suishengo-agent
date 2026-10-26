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

| 配置                  | 默认行为                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `context.compaction`  | 触发比例 0.7，优先保留近期 2 轮，摘要上限 1024 tokens；设为 `false` 关闭 |
| `runtime.limits`      | 每轮最多 8 个模型步骤、12 次工具调用、32000 tokens                       |
| `runtime.concurrency` | 全局最多 8 个运行，每个用户最多 2 个                                     |
| `runtime.timeoutMs`   | 每轮 120000 毫秒                                                         |

对话和摘要共用模型与运行 token 预算，摘要不调用业务工具。预算不足可提前触发压缩，窗口不足时可减少保留的旧交互。上下文大小使用保守 UTF-8 字节估算；压缩可能损失信息，原始历史保留在数据库。具体算法与持久化规则见[上下文与摘要](architecture.md#上下文与摘要)。

真实模型联调使用有权限的测试密钥，验证文本、reasoning、工具往返、usage 和取消。`pnpm eval` 的运行方式和验证边界见[开发约定](development.md#真实模型冒烟)。

## 配置文件与部署参数

默认读取随应用发布的 `apps/backend/config.yaml`，与进程工作目录无关。`CONFIG_FILE` 可指定另一份完整文件，建议使用绝对路径；相对路径按进程工作目录解析。自定义文件不会与默认文件合并，省略的可选字段按所属契约补默认值。YAML 未知字段和不合法配置会启动失败；修改文件后重启生效。

配置文件按能力分组，插件拥有自身参数约束，应用负责生产认证、远程 Prompt 连接等跨能力校验。策略只从 YAML 读取，部署参数和凭据从环境变量读取。`loadConfig` 解析后形成完整对象，插件不查询全局配置服务。迁移命令只读取 `DATABASE_URL`，不加载模型或 HTTP 配置。

| 变量                       | 默认值                               | 用途                                       |
| -------------------------- | ------------------------------------ | ------------------------------------------ |
| `CONFIG_FILE`              | 随应用发布的 config.yaml             | 选择完整配置文件                           |
| `NODE_ENV`                 | development                          | 运行环境，生产部署设置为 production        |
| `HOST`                     | 127.0.0.1                            | HTTP 监听地址；容器内为 0.0.0.0            |
| `PORT`                     | 4400                                 | HTTP 监听端口                              |
| `LOG_LEVEL`                | info                                 | 诊断日志级别                               |
| `APP_RELEASE`              | 无                                   | 观测中的 commit 或镜像版本                 |
| `LANGFUSE_CAPTURE_CONTENT` | production 为 false，其他环境为 true | 部署环境是否允许采集经过大小限制的输入输出 |

配置文件选择能力及参数，插件依赖与挂载顺序由 `application.ts` 管理。

远程 Prompt 和 MCP 的条件配置见下文。frontend 的 `AGENT_ACCESS_TOKEN` 和 `BACKEND_URL`（默认 `http://127.0.0.1:4400`）、eval 的 `EVAL_BASE_URL` / `EVAL_TOKEN`、集成测试的 `TEST_DATABASE_URL` 分别属于对应入口；生产 Compose 的 `BACKEND_IMAGE` 和可选 `HTTP_PORT` 属于部署配置。

## 产品 Prompt 与 Langfuse

产品 Prompt 默认来自 [backend/agent/prompts.ts](../apps/backend/src/agent/prompts.ts)。YAML 的 `prompts.remote` 可指定 text Prompt 的 `name` 和正整数 `version`；服务在启动时读取该固定版本，读取失败会阻止启动。

Langfuse 连接需要完整的 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY`。三项全部留空时关闭外部导出，部分配置会启动失败；远程 Prompt 也需要这组连接参数。部署前核对所选 Langfuse 服务版本与工程锁定 SDK 的兼容性。

观测按 Run → Step → Operation 建立层级，记录实际触发的上下文压缩与摘要保存、摘要及对话模型调用、工具调用；运行终态与提交失败记录在 Run 上。generation 记录标准模型字段、实际 usage、首个生成内容时间、结束原因及最终 system 文本哈希。远程 Prompt 的名称和固定版本随请求关联到对话 generation；摘要调用不冒用产品 Prompt 版本。无价格配置时不主动上报零费用，平台费用推算仍需正确的模型价格映射。

`NODE_ENV` 作为观测环境；可选 `APP_RELEASE` 标识 commit 或镜像版本。会话和运行关联传播到每个节点，Step 与 toolCall 关联在相应作用域内传播。当前不上报用户标识，只保留业务查询所需的 runId/sessionId。

`LANGFUSE_CAPTURE_CONTENT` 在 development/test 默认开启，在 production 默认关闭。开启后记录用户问题、回答、模型消息与工具参数和结果。结构化内容在序列化前屏蔽常见凭据字段，并限制深度、条目数和单字段大小；这些规则不保证任意业务正文都已脱敏。模型实际请求不受观测内容处理影响。

观测导出不提供持久化队列或送达保证。平台联调在专用测试项目中按 runId 回读 Run、Step、generation 和 tool，检查父子关系、输入输出、usage、Prompt 版本，并按 purpose/status/stepId 筛选。模拟 OTLP 接收成功只验证本地导出协议。远程 Prompt 联调需确认配置的固定版本实际生效。开发实例准备见[开发环境](../deploy/development/README.md)。

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

联调分别确认：服务认证、用户身份委托、允许目录、参数验证、成功结果、无权限、超时和取消。`/api/capabilities` 的 `businessTools` 只反映工具配置存在，不表示远端可用或业务验收通过。
