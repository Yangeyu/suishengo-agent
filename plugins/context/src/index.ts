import type { Sessions } from "@harness";
import type { Contexts, ContextStore } from "@harness/context";
import type { Telemetry } from "@harness/telemetry";
import type { ContextOptions } from "@plugins/context/src/config";
import { contextCompaction } from "@plugins/context/src/compaction";
import { summaryVersion } from "@plugins/context/src/prompts";

/** Context owns summary production and the rules for reusing persisted summaries. */
export function createContext(options: {
  sessions: Pick<Sessions, "getRun" | "history">;
  store: ContextStore;
  config: ContextOptions;
  telemetry: Telemetry;
}) {
  const { sessions, store, config, telemetry } = options;
  const policy = config.compaction;
  const contexts: Contexts = {
    async load(actor, runId, prompts) {
      const run = await sessions.getRun(actor, runId);
      const stored = policy ? await store.loadSummary(actor, run.sessionId) : undefined;
      const version = policy ? summaryVersion(policy.version, prompts) : undefined;
      const summary = stored?.policyVersion === version ? stored : undefined;
      const turns = await sessions.history(actor, run, { after: summary?.throughPosition });
      return { turns, summary, summaryRevision: stored?.revision ?? 0 };
    },
  };
  return { contexts, middleware: policy ? [contextCompaction({ store, policy, telemetry })] : [] };
}
