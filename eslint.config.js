import { fileURLToPath } from "node:url";
import babelParser from "@babel/eslint-parser";
import importPlugin from "eslint-plugin-import";

const root = fileURLToPath(new URL(".", import.meta.url));

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".data/**", "plugins/sessions-pg/migrations/**"],
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.ts", "plugins/**/*.ts", "scripts/*.{ts,mjs}"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
        },
      },
    },
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: {
          conditionNames: ["import", "node", "default"],
          noWarnOnMultipleProjects: true,
          project: [root + "tsconfig.json", root + "apps/frontend/tsconfig.json"],
        },
      },
    },
    rules: {
      "no-debugger": "error",
      "no-unreachable": "error",
      eqeqeq: ["error", "always"],
      "import/no-unresolved": "error",
      "import/no-duplicates": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./*", "../*", "@backend/*.js", "@plugins/*.js", "@frontend/*.js"],
              message: "内部源码使用 @ 别名且省略 .js；第三方导出路径保持原样。",
            },
          ],
        },
      ],
      "import/no-restricted-paths": [
        "error",
        {
          basePath: root,
          zones: [
            {
              target: "./apps/frontend/src",
              from: [
                "./apps/backend",
                "./apps/eval",
                "./plugins",
                "./packages/runtime",
                "./packages/flow",
                "./packages/logging",
              ],
              message: "浏览器不能引入服务端实现。",
            },
            {
              target: "./apps/frontend/src",
              from: "./packages/harness",
              except: ["src/sessions/index.ts"],
              message: "浏览器只共享会话数据类型。",
            },
            {
              target: "./packages",
              from: ["./apps", "./plugins"],
              message: "核心模块不能反向依赖应用组装或插件实现。",
            },
            {
              target: "./plugins",
              from: "./apps",
              message: "插件通过参数接收产品能力，不依赖应用。",
            },
            {
              target: "./packages/harness",
              from: ["./packages/runtime", "./packages/flow", "./packages/logging"],
              message: "能力契约不依赖执行实现。",
            },
            {
              target: ["./packages/flow", "./packages/logging"],
              from: ["./packages/runtime", "./packages/harness"],
              message: "基础执行与日志能力不能依赖业务契约。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/**/*.ts", "plugins/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value='ai']",
          message: "AI SDK 消息与流协议归 HTTP 适配层，核心与存储只使用领域契约。",
        },
      ],
    },
  },
  {
    files: ["packages/**/*.ts", "plugins/**/*.ts"],
    ignores: ["plugins/telemetry/**", "plugins/prompts/**", "**/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value='ai']",
          message: "AI SDK 协议归 HTTP 适配层。",
        },
        {
          selector: "ImportDeclaration[source.value=/^@langfuse\\//]",
          message: "Langfuse 实现归 telemetry/prompts 插件；执行代码只依赖 harness 契约。",
        },
        {
          selector: "ImportDeclaration[source.value=/^@plugins\\/telemetry\\//]",
          message: "运行逻辑不能反向依赖观测插件实现。",
        },
      ],
    },
  },
  {
    files: ["apps/frontend/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value='@harness/sessions'][importKind!='type']",
          message: "会话契约仅使用 type-only 导入，浏览器不加载 harness 实现。",
        },
      ],
    },
  },
];
