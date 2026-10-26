import type { ToolInterceptor } from "@harness/tools";
import {
  ServiceError,
  type JsonValue,
  type Sessions,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
  type ToolSession,
  type Tools,
  type Telemetry,
} from "@harness";
import type { Context } from "@deepseek-ai/cordis";
import { Ajv, type ValidateFunction } from "ajv";
import { pipeline, policy, type ExecutionContext } from "@flow";
import { logger, withLogContext } from "@logging";
import { searchCurrentSession } from "@plugins/tools/src/builtins/search-current-session";

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: Tools;
  }
}

type Options = {
  sessions?: Pick<Sessions, "getRun" | "search">;
  definitions?: ToolDefinition[];
  sources: (ToolSource | undefined)[];
};
type Invocation = {
  input: unknown;
  validate: ValidateFunction;
  tool: ToolDefinition;
  context: ToolContext;
  callId: string;
};

function validateInput(call: Invocation, execution: ExecutionContext) {
  call.context = { ...call.context, signal: execution.signal ?? call.context.signal };
  if (!call.validate(call.input)) {
    throw new ServiceError("TOOL_INPUT_INVALID", "工具参数不符合约定");
  }

  return call;
}

async function authorize(call: Invocation) {
  if (!(await call.tool.authorize(call.context))) {
    throw new ServiceError("TOOL_FORBIDDEN", "无权调用该工具");
  }

  return call;
}

async function execute(call: Invocation) {
  const result = await call.tool.execute(call.input as Record<string, JsonValue>, {
    ...call.context,
    callId: call.callId,
  });

  return result;
}

function validateOutput(result: unknown) {
  const serialized = JSON.stringify(result);
  if (serialized === undefined || Buffer.byteLength(serialized) > 65536) {
    throw new ServiceError("TOOL_OUTPUT_INVALID", "工具输出为空或超过大小限制");
  }

  return JSON.parse(serialized) as JsonValue;
}

function createToolSession(
  definitions: ToolDefinition[],
  context: ToolContext,
  maxCalls: number,
  telemetry: Telemetry,
  close: () => Promise<void>,
  intercept?: ToolInterceptor,
): ToolSession {
  const invocation = pipeline(validateInput, authorize, (call: Invocation) =>
    intercept
      ? intercept(
          {
            callId: call.callId,
            name: call.tool.name,
            input: call.input as Record<string, JsonValue>,
          },
          () => execute(call),
        )
      : execute(call),
  );
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  const registry = new Map<string, { tool: ToolDefinition; validate: ValidateFunction }>();
  let calls = 0;

  for (const tool of definitions) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || registry.has(tool.name)) {
      throw new Error("Invalid or duplicate tool name");
    }
    if (tool.inputSchema.type !== "object") throw new Error("Tool input must be an object schema");

    registry.set(tool.name, { tool, validate: ajv.compile(tool.inputSchema) });
  }

  async function invoke(callId: string, name: string, input: unknown) {
    context.signal.throwIfAborted();
    if (++calls > maxCalls) throw new ServiceError("TOOL_LIMIT", "工具调用次数已达上限");

    const entry = registry.get(name);
    if (!entry) throw new ServiceError("TOOL_NOT_FOUND", "工具不存在或未开放");
    const call = { ...entry, context, callId, input };

    try {
      // 不自动重试工具；写操作能否重试必须由业务方的幂等契约决定。
      return validateOutput(
        await policy(invocation).timeout(entry.tool.timeoutMs).build()(call, {
          signal: context.signal,
        }),
      );
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof ServiceError) throw error;

      throw new ServiceError("TOOL_FAILED", "工具执行失败或超时", { cause: error });
    }
  }

  return {
    definitions: definitions.map(({ name, displayName, description, inputSchema }) => {
      const title = displayName?.trim();
      const validTitle =
        title && Array.from(title).length <= 80 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title);
      return {
        name,
        ...(validTitle ? { displayName: title } : {}),
        description,
        inputSchema,
      };
    }),
    close,

    invoke: (callId, name, input) =>
      withLogContext({ toolCallId: callId }, () =>
        telemetry.observe(
          {
            name: "tool.execute",
            type: "tool",
            signal: context.signal,
            correlation: { runId: context.runId, sessionId: context.sessionId, toolCallId: callId },
            metadata: { tool: name },
          },
          async (observation) => {
            if (input !== undefined) observation.update({ input: input as JsonValue });
            const result = await invoke(callId, name, input);
            observation.update({ output: result });
            return result;
          },
        ),
      ),
  };
}

export const toolsPlugin = {
  name: "tools",
  inject: ["telemetry"],

  apply(ctx: Context, options: Options) {
    const definitions = [
      ...(options.sessions ? [searchCurrentSession(options.sessions)] : []),
      ...(options.definitions ?? []),
    ];
    const sources = options.sources.filter((source) => source !== undefined);
    const telemetry = ctx.telemetry;
    ctx.provide("tools", {
      configured: definitions.length > 0 || sources.length > 0,

      async open(context, maxCalls, intercept) {
        const opened: Awaited<ReturnType<ToolSource["open"]>>[] = [];

        const close = async () => {
          for (const source of opened.splice(0).reverse()) {
            try {
              await source.close();
            } catch {
              logger.warn({ event: "tools.close_failed" });
            }
          }
        };

        try {
          for (const source of sources) opened.push(await source.open(context));
          const available = [...definitions, ...opened.flatMap((source) => source.tools)];

          return createToolSession(available, context, maxCalls, telemetry, close, intercept);
        } catch (error) {
          // 后续来源初始化失败时，也要释放已经打开的连接。
          await close();
          throw error;
        }
      },
    } satisfies Tools);
  },
};
