# 工程协作入口

这是随申 GO 独立 AI 后端。业务后端拥有用户、票根、权益与核销等业务事实；本工程拥有 AI 会话、消息、运行和输出事件。

## 核心约束

- 所有会话、运行、重放和取消入口都以已验证身份检查所有权。身份不得来自模型参数、消息正文或浏览器传入的 userId；业务工具仍需业务后端授权。
- `apps/backend/src/application.ts` 是组装入口；Cordis 管理资源生命周期，运行逻辑通过明确参数使用依赖。能力契约归 harness，运行生命周期归 runtime；harness/sessions 拥有会话数据与状态规则，harness/execution 拥有执行与钩子契约，HTTP 请求校验和错误状态映射归 backend/http；产品 Prompt 归 backend/agent。
- 核心消息、运行状态与对应核心事件在同一事务提交。AI SDK 消息与流转换仅属于 backend/http；PG 不依赖 SDK。HTTP 断连只停止订阅，取消运行使用明确接口。
- Drizzle schema 与提交的 migrations 管理数据结构；部署单独执行迁移，HTTP 启动不修改 schema。
- 当前单执行实例支持多用户并发。多副本需要先设计运行租约与恢复，不直接移除数据库执行实例锁。
- 正式部署只运行 backend HTTP 服务。PG、Langfuse 等由外部提供；frontend 是开发工作台，eval 是独立命令。
- 测试使用专用 `_test` 数据库，不使用真实用户数据或线上密钥。区分本地检查、模拟协议、真实服务联调和业务验收的证据。

## 按任务阅读

根据本次修改范围选择以下文档；跨边界任务读取相关的几篇，局部修改无需通读全部文档。

| 修改内容                                         | 阅读位置                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| 模块归属、依赖、组装、运行状态、并发、事务或恢复 | [架构设计](docs/architecture.md)                                            |
| 源码组织、导入、测试、构建、迁移或文档维护       | [开发约定](docs/development.md)                                             |
| HTTP 请求响应、消息投影、流式协议或客户端交互    | [客户端接入](docs/api/README.md)，字段查阅 [OpenAPI](docs/api/openapi.json) |
| 身份系统、模型、Prompt、Langfuse 或业务工具      | [外部接入](docs/integrations.md)                                            |
| 开发基础设施                                     | [开发环境](deploy/development/README.md)                                    |
| 生产配置、镜像发布、迁移或升级                   | [生产部署](deploy/production/README.md)                                     |

新增能力先明确完整场景与归属，不预建空目录、通用工厂或未来兼容层。修改时同步清理相关调用、配置与说明。必要验证按开发约定执行，工程检查入口为 `pnpm check`。
