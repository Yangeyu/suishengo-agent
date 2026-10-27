# 客户端接入

本文描述如何消费随申 GO Agent HTTP 服务。路径、字段与状态码查阅 [OpenAPI 3.1 契约](openapi.json)；内部执行和事务见[架构设计](../architecture.md)。示例默认服务地址 `http://127.0.0.1:4400`。

## 认证与能力

除 `/health/live`、`/health/ready` 外，所有接口携带 `Authorization: Bearer <token>`。用户身份从验证后的 JWT 取得；请求不接受可信 userId、system Prompt 或完整会话历史。跨用户访问会话或运行返回 404。

`GET /api/capabilities` 返回模型配置、业务工具配置和协议版本。`businessTools` 不包含默认启用的 `search_current_session` 会话历史检索。配置状态不代表外部服务联通；readiness 也不代表模型、MCP 或 Langfuse 可用。

开发工作台通过 Vite 同源代理访问服务，代理从环境配置 `AGENT_ACCESS_TOKEN` 取得访问凭证并附加认证头；凭证不进入浏览器构建产物。正式客户端应配置自己的服务地址和网络入口；当前后端没有承诺通用跨域浏览器访问能力。

## 完成一次对话

1. 调用 `POST /api/sessions` 创建会话，保存返回的 `id`。请求可以为 `{}`；标题缺省为“新对话”。
2. 为本次用户消息生成 `requestId` 和 `message.id` 两个 UUID，保留原请求用于网络失败后的重试。
3. 调用 `POST /api/chat`，先检查 HTTP 状态和 Content-Type；成功时保存 `x-run-id` 并消费 SSE。
4. 按流中 `start.messageId` 更新对应 assistant 消息。需要确认运行结果时查询 `GET /api/runs/{id}`，需要完整消息快照时读取 `GET /api/sessions/{id}`。

创建会话：

```sh
curl -sS "$BASE_URL/api/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"title":"出行咨询"}'
```

发送消息的请求结构如下，UUID 请按本次会话和消息替换：

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "requestId": "00000000-0000-4000-8000-000000000002",
  "message": {
    "id": "00000000-0000-4000-8000-000000000003",
    "role": "user",
    "parts": [{ "type": "text", "text": "你好" }]
  }
}
```

只接受一个 text part，原始文本长度 1–4000 字符，trim 后不能为空；请求体限制 32768 字节。服务端加载历史，客户端不回传此前全部消息。

## 流式消息

服务使用 [AI SDK UI Message Stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)，媒体类型为 `text/event-stream`，协议头为 `x-vercel-ai-ui-message-stream: v1`。

JSON 事件通过 SSE 的 `data:` 字段发送；`data: [DONE]` 表示传输结束，注释心跳不属于消息内容。按 SSE 帧解析，不能假设一次网络 read 就是一条完整 JSON。浏览器原生 EventSource 不适合直接完成带 Bearer 请求头的 POST，对话入口应使用 fetch 流或兼容的客户端 transport。

当前输出包括消息开始、步骤开始/结束、文本及 reasoning 开始/增量/结束、工具输入/结果/错误、运行错误、abort 和 finish。具体结构见 OpenAPI 的 `UIMessageChunk`；它描述当前服务输出的 SDK 事件子集。`UIMessage` 是 HTTP 从核心消息生成的展示快照，包含文本、reasoning、步骤与动态工具 parts。核心存储不使用 SDK 消息结构。

流中的工具错误不一定使整个运行失败。`[DONE]` 仅说明流已结束；业务完成状态以运行查询为准。

### 工具展示名称

快照的 `dynamic-tool` part 和流中的 `tool-input-available` 可携带 `toolMetadata: { "displayName": "检索当前会话" }`。客户端优先显示非空字符串 `displayName`，缺失时回退 `toolName`；`toolName` 是原始工具标识。结果与错误事件按 `toolCallId` 更新同一工具 part，客户端应保留已收到的展示元数据。

名称由服务端在调用记录提交时保存，实时消息、刷新和整轮重放使用同一份值，工具定义变更不影响已保存的标题。标题按普通文本渲染，不作为 HTML/Markdown 执行。存储归属见[架构设计](../architecture.md#前端工具展示名称)。

## 幂等与并发

`sessionId + requestId` 是幂等键。重试保留相同 `message.id` 和 trim 后文本，服务返回同一 run 并重放其输出；修改其中任一项返回 409 `IDEMPOTENCY_CONFLICT`。新的用户消息使用新标识。

同一会话只允许一个活跃运行，重叠提交返回 409 `SESSION_BUSY`；超过用户或全局并发额度返回 429 `CAPACITY_EXCEEDED`。不同会话可并发，具体额度由服务端配置。

`message.id` 需要唯一，不要把同一个消息 ID 用于不同提交。重复请求仍需通过认证和当前运行入口检查，并不绕过服务不可用状态。

## 断连、重放与取消

关闭页面或断开 HTTP 流只结束订阅，不取消 Agent。重连时先读会话快照，使用 `activeRun.id` 找到仍在执行的运行；已保存的 runId 也可直接查询或重放。

`GET /api/runs/{id}/stream` 从头返回该 run 的完整事件；运行未结束时继续订阅后续事件。没有公开的事件游标续传协议，不依赖 `Last-Event-ID`。客户端按照 assistant messageId 替换此前部分消息，避免把重放文本重复追加。

主动停止调用：

```sh
curl -sS -X POST "$BASE_URL/api/runs/$RUN_ID/cancel" \
  -H "Authorization: Bearer $TOKEN"
```

接口等待本地运行收尾后返回最新 run；已经完成的运行保持原终态。取消本地执行不代表远端业务副作用已回滚，涉及业务写操作时应查询业务服务的权威状态。

## 错误与运行结果

建流前的失败使用 HTTP 状态码及统一 JSON：

```json
{ "error": { "code": "SESSION_BUSY", "message": "当前会话仍在处理中" } }
```

常见错误包括 400 输入错误、401 身份无效、404 资源不可见、409 幂等或会话冲突、429 并发额度、503 服务或模型未就绪。框架对无效 JSON、媒体类型或过大请求体的错误使用 `REQUEST_FAILED`；精确接口响应见 OpenAPI。

SSE 建立后不能重新返回 HTTP 错误状态。模型失败、超时或中断通过流事件及运行状态表达；订阅自身故障时重新查询或重放，不能仅凭连接断开断定运行失败。

运行终态包括 `completed`、`failed`、`cancelled`、`interrupted`。服务重启会将遗留运行标记为 interrupted，不自动重做模型或工具操作。客户端保留已收到的部分内容，并提供与实际状态对应的反馈。

运行查询只返回公开的 Run 字段。assistant 展示消息 ID 等于 runId；模型来源、回放元数据和核心消息内部状态不会输出给前端。

## 契约维护

`openapi.json` 采用 OpenAPI 3.1，随接口实现一同维护，可直接编辑并导入支持该版本的接口工具。接口行为变化时同步更新相关接入说明；工具生成的客户端仍需实现上述 SSE 消费、取消和重放语义。
