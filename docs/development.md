# 开发约定

本文用于修改源码、构建、迁移、验证和维护文档。首次启动见[根 README](../README.md)，模块归属见[架构设计](architecture.md)。

## 源码与构建

`packages` 和 `plugins` 是根工程内的源码模块，不独立声明 package.json。workspace 保留 backend 命令入口及拥有独立前端依赖和构建的 frontend；eval 由根命令执行。

内部源码导入使用 tsconfig 中配置的 `@` 路径别名，省略 `.js`。CSS 等资源保留后缀；第三方包的导出路径遵循该包约定。TypeScript 使用 ESNext + Bundler 解析，后端构建通过 tsc-alias 转为带 `.js` 的 Node ESM 相对路径。

```sh
pnpm typecheck
pnpm build:backend
pnpm start
pnpm build:frontend
```

[后端构建脚本](../scripts/build-backend.mjs) 清理输出、编译、处理别名并复制 migrations。生产使用完整的 `pnpm build:backend` 产物，不能只运行 tsc 后直接部署。测试参与类型检查，生产构建排除 `__tests__`。

使用 `pnpm format` 统一格式，`pnpm format:check` 检查格式。Prettier 负责缩进和长行，语义空行仍按完整行为分组，注释解释意图、取舍与关键约束。

`pnpm lint` 检查导入解析与模块依赖方向：核心模块不依赖应用和插件，插件不依赖应用，浏览器只通过 type-only 导入基础会话类型，展示类型由客户端使用 SDK 描述。规则见根目录 `eslint.config.js`。TypeScript 7 的类型检查由 tsc 执行，lint 使用 Babel 解析语法。

## 数据库变更

schema、生成配置、migrations 归 `plugins/sessions-pg`。修改 schema 后执行：

```sh
pnpm db:generate
# 审阅生成 SQL，确认数据约束
pnpm db:migrate
```

schema 与对应 migrations 一起提交。当前初始化基线面向空数据库，不提供旧实验表结构的转换；已有实验数据库需要保留时，使用新数据库初始化，不能将新基线直接套到旧表上。迁移是独立命令，HTTP 启动不自动修改数据库结构。正式环境的迁移和升级顺序见[生产部署](../deploy/production/README.md)。

## 验证范围

| 修改范围               | 验证方式                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| 纯文档与导航           | 核对内容、链接与当前实现                                                   |
| HTTP、协议或 OpenAPI   | 核对接口契约、运行相关 HTTP/协议测试；涉及持久化行为时补充真实 PG 集成验证 |
| 存储、并发、取消、恢复 | 类型检查及专用 PG 集成测试                                                 |
| 模型或 MCP 协议        | 对应协议验证；外部服务联调需使用测试身份和实际服务                         |
| 完整工程变更           | `pnpm check`                                                               |

`pnpm check` 执行格式、lint、类型检查、模块测试和构建。模块测试放在所属模块的 `__tests__`；真实 PG + HTTP 集成测试位于 `apps/backend/__tests__/integration`，通过独立命令运行。

测试聚焦认证、用户隔离、并发、取消、重放和外部协议。复用已有验证，只为缺少保障的重要行为补充测试。简单转发、私有实现细节和纯说明调整不单独补测试；简化实现时同步精简失效测试和夹具。

## 真实 PG 集成验证

测试会清空目标库的会话数据，只允许使用库名以 `_test` 结尾的专用数据库。启动开发 PG 后，首次创建测试库：

```sh
docker compose -f deploy/development/compose.yaml exec -T postgres createdb -U suishengo suishengo_agent_test
```

之后在仓库根目录运行：

```sh
TEST_DATABASE_URL=postgresql://suishengo:local-development@127.0.0.1:5438/suishengo_agent_test pnpm test:integration
```

不设置 `TEST_DATABASE_URL` 时测试可能跳过，不能据此声称 PG 验证通过。检查测试报告中的通过、失败和跳过数。集成测试包含 HTTP → Pi → 本地 MCP → PG → AI SDK 的完整调用、两用户并发身份隔离、工具历史续接及重放；Langfuse 导出协议另由本地 OTLP 接收端验证父子 span 和关闭时刷新。上下文集成测试另外覆盖超过十轮历史、摘要持久化与重启复用、所有权、版本冲突以及生成期间取消。测试使用的 Agent 或模型夹具只证明相应本地链路，不证明真实模型、业务工具或 Langfuse 联通。

真实模型 HTTP 冒烟验证使用专用评测用户：

```sh
EVAL_TOKEN='<测试用户令牌>' EVAL_BASE_URL=http://127.0.0.1:4400 pnpm eval
```

它会创建会话并调用模型，检查流终止和运行完成，不对答案质量打分。外部服务的验收证据应分别报告，见[外部接入](integrations.md)。

## 文档与接口契约维护

根 README 提供启动和人类阅读导航，AGENTS 提供核心约束和任务索引。主题文档解释当前行为与设计原因；同一规则保留一个主要维护位置，其他地方使用链接。按任务阅读，不要求每次修改通读所有文档。

未实现的设计明确写作建议或待接入内容。新增文档要有完整、独立的阅读需求，不为目录对称创建空文件。变更涉及的文档随实现更新，删除失效内容，不追加修正流水。

接口行为变化时，同步维护 [OpenAPI](api/openapi.json) 和相关[客户端接入说明](api/README.md)。OpenAPI 描述路径、请求响应和事件结构；接入说明解释调用流程、取消和重放语义。
