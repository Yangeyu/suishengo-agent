import type { Telemetry, Observation } from "@harness/telemetry";
import { ServiceError } from "@harness";
import { executionFailure } from "@harness/errors";
import { estimateContext, type ContextStore, type ContextSummary } from "@harness/context";
import type { ModelInput, ModelRequest, ScopedModels } from "@harness/models";
import type { HistoryTurn } from "@harness/sessions";
import type { AgentMiddleware } from "@harness/execution/middleware";
import type { RunScope } from "@harness/scope";
import type { AgentMessage } from "@harness/messages";
import { pipeline } from "@flow";
import { renderPrompt, type PromptInput } from "@harness/prompts";
import { compactionPrompt, summaryVersion } from "@plugins/context/src/prompts";
import type { CompactionPolicy } from "@plugins/context/src/config";

import { logger } from "@logging";

type CompactionState = {
  history: HistoryTurn[];
  historyMessageCount: number;
  removedGroups: number;
  summary: string | undefined;
  pendingSummary: Omit<ContextSummary, "revision"> | undefined;
  lossy: boolean;
};

type CompactionInput = {
  request: ModelRequest;
  scope: RunScope;
  models: ScopedModels;
  policy: CompactionPolicy;
  instructions: PromptInput;
  state: CompactionState;
  telemetry: Telemetry;
};

type CompactionContext = CompactionInput & {
  user: Extract<AgentMessage, { role: "user" }>;
  recent: AgentMessage[][];
  groups: AgentMessage[][];
};

export function contextCompaction(options: {
  store: ContextStore;
  policy: CompactionPolicy;
  telemetry: Telemetry;
}): AgentMiddleware {
  const { store, policy, telemetry } = options;
  return {
    name: "context-compaction",
    prompts: [compactionPrompt],
    create(scope, { models, history: conversation, prompts }) {
      const instructions = renderPrompt(prompts[compactionPrompt.key]!);
      const resolvedPolicy = { ...policy, version: summaryVersion(policy.version, prompts) };
      const history = conversation.turns.filter((turn) => turn.completed);
      // One state per run; later model requests continue from the same compaction boundary.
      const state: CompactionState = {
        history,
        historyMessageCount: history.reduce((sum, turn) => sum + turn.messages.length, 0),
        removedGroups: 0,
        summary: conversation.summary?.text,
        pendingSummary: undefined,
        lossy: false,
      };

      const prepareContext = pipeline(
        (request: ModelRequest) =>
          prepareRequest({
            request,
            scope,
            models,
            policy: resolvedPolicy,
            instructions,
            state,
            telemetry,
          }),
        compactContext,
        projectContext,
      );

      return {
        beforeModel: prepareContext,
        async afterAgent() {
          if (!state.pendingSummary) return;
          scope.signal.throwIfAborted();
          const summary = state.pendingSummary;
          const save = () =>
            store.saveSummary(
              scope.actor,
              scope.sessionId,
              summary,
              conversation.summaryRevision,
              scope.signal,
            );
          await telemetry.observe(
            {
              name: "context.save",
              signal: scope.signal,
              metadata: {
                throughPosition: summary.throughPosition,
                policyVersion: summary.policyVersion,
              },
            },
            save,
          );
        },
      };
    },
  };
}

function prepareRequest(input: CompactionInput): CompactionContext {
  const current = input.request.context.messages.slice(input.state.historyMessageCount);
  const user = current[0];
  if (user?.role !== "user") throw new ServiceError("CONTEXT_MESSAGES", "当前用户输入缺失");

  const recent = exchanges(current.slice(1));
  const groups = [...input.state.history.map((turn) => turn.messages), ...recent];
  return { ...input, user, recent, groups };
}

async function compactContext(ctx: CompactionContext): Promise<CompactionContext> {
  let view = projectContext(ctx);
  const trigger = Math.floor(ctx.request.model.contextWindow * ctx.policy.triggerFraction);

  if (estimateContext(view) <= Math.min(inputLimit(ctx), trigger)) return ctx;
  const before = estimateContext(view);
  const removedBefore = ctx.state.removedGroups;
  const compact = async (observation: Observation) => {
    while (estimateContext(view) > Math.min(inputLimit(ctx), trigger)) {
      const end = selectBatchEnd(ctx, view);
      if (end === undefined) break;
      if (!(await compactBatch(ctx, end, view, observation))) break;
      view = projectContext(ctx);
    }
    observation.update(() => ({
      metadata: {
        afterSize: estimateContext(view),
        removedGroups: ctx.state.removedGroups - removedBefore,
        lossy: ctx.state.lossy,
        durableCandidate: Boolean(ctx.state.pendingSummary),
      },
    }));
    return ctx;
  };
  return ctx.telemetry.observe(
    {
      name: "context.compact",
      signal: ctx.scope.signal,
      metadata: {
        trigger: inputLimit(ctx) < trigger ? "budget-or-window" : "threshold",
        beforeSize: before,
        policyVersion: ctx.policy.version,
        sizeUnit: "utf8-bytes-with-overhead",
      },
    },
    compact,
  );
}

function selectBatchEnd(ctx: CompactionContext, view: ModelInput): number | undefined {
  const { state, policy, models, groups, recent } = ctx;
  const preserve =
    estimateContext(view) > inputLimit(ctx) ? Math.min(1, recent.length) : policy.keepRecentTurns;
  const end = Math.max(state.removedGroups, groups.length - preserve);
  if (state.removedGroups >= end) return;

  // Historical summaries stop before this run, even when the model could fit more groups.
  const boundary =
    state.removedGroups < state.history.length ? Math.min(end, state.history.length) : end;
  const model = models.resolve();
  let next = state.removedGroups + 1;
  while (next < boundary) {
    const draft = summaryContext(
      ctx.instructions,
      state.summary,
      groups.slice(state.removedGroups, next + 1),
    );
    if (estimateContext(draft) + policy.maxSummaryTokens > model.contextWindow) break;
    next++;
  }
  return next;
}

async function compactBatch(
  ctx: CompactionContext,
  end: number,
  view: ModelInput,
  observation: Observation,
): Promise<boolean> {
  const { state, scope, models, policy } = ctx;
  let text: string;
  try {
    text = await summarize(ctx, ctx.groups.slice(state.removedGroups, end));
  } catch (error) {
    scope.signal.throwIfAborted();
    if (scope.budget.remaining <= 0) throw error;
    const retain = estimateContext(view) <= inputLimit(ctx);
    observation.event(
      "context.compaction_fallback",
      {
        metadata: {
          action: retain ? "retain-context" : "drop-old-groups",
          removedGroups: retain ? 0 : end - state.removedGroups,
        },
      },
      executionFailure(error),
    );
    if (retain) return false;

    // Dropping complete groups is lossy; no later batch can repair the missing history.
    state.lossy = true;
    state.pendingSummary = undefined;
    logger.warn({ event: "context.compaction_fallback", runId: scope.runId });
    state.removedGroups = end;
    return true;
  }

  state.summary = text;
  state.removedGroups = end;
  if (!state.lossy && end <= state.history.length) {
    state.pendingSummary = {
      throughPosition: state.history[end - 1]!.position,
      text,
      policyVersion: policy.version,
      modelId: models.resolve().id,
    };
  }
  return true;
}

async function summarize(ctx: CompactionContext, groups: AgentMessage[][]): Promise<string> {
  const { scope, models, policy, state } = ctx;
  scope.signal.throwIfAborted();
  const model = models.resolve();
  const maxOutputTokens = Math.min(
    policy.maxSummaryTokens,
    model.maxOutputTokens,
    scope.budget.remaining,
  );
  const request: ModelRequest = {
    model,
    purpose: "compaction",
    maxOutputTokens,
    context: summaryContext(ctx.instructions, state.summary, groups),
  };
  if (
    maxOutputTokens < 1 ||
    estimateContext(request.context) + maxOutputTokens >
      Math.min(model.contextWindow, scope.budget.remaining)
  ) {
    throw new ServiceError("COMPACTION_LIMIT", "摘要输入超过预算");
  }

  const result = await models.generate(request);
  scope.signal.throwIfAborted();
  if (result.finishReason !== "stop") throw new ServiceError("COMPACTION_FAILED", "摘要未完整生成");
  const text = result.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) throw new ServiceError("COMPACTION_FAILED", "摘要为空");
  return text;
}

function summaryContext(
  instructions: PromptInput,
  summary: string | undefined,
  groups: AgentMessage[][],
): ModelInput {
  return {
    system: instructions,
    messages: [
      { role: "user", text: JSON.stringify({ previousSummary: summary, conversation: groups }) },
    ],
    tools: [],
  };
}

function projectContext({ request, state, user, recent }: CompactionContext): ModelInput {
  // Canonical messages stay untouched; this is only the next model request's view.
  return {
    ...request.context,
    summary: state.summary,
    messages: [
      ...state.history.slice(state.removedGroups).flatMap((turn) => turn.messages),
      user,
      ...recent.slice(Math.max(0, state.removedGroups - state.history.length)).flat(),
    ],
  };
}

function inputLimit({ request, scope }: CompactionContext): number {
  return Math.min(request.model.contextWindow, scope.budget.remaining) - request.maxOutputTokens;
}

function exchanges(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "assistant" || !groups.length) groups.push([message]);
    else groups.at(-1)!.push(message);
  }
  return groups;
}
