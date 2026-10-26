import type { Sessions } from "@harness";
import type { Contexts, ContextStore } from "@harness/context";

/** Context policy chooses the history range; storage only queries facts. */
export function createContexts(
  sessions: Sessions,
  store: ContextStore,
  policyVersion?: string,
): Contexts {
  return {
    async load(actor, runId) {
      const run = await sessions.getRun(actor, runId);
      const stored = policyVersion ? await store.loadSummary(actor, run.sessionId) : undefined;
      const summary = stored?.policyVersion === policyVersion ? stored : undefined;
      const turns = await sessions.history(actor, run, { after: summary?.throughPosition });
      return { turns, summary, summaryRevision: stored?.revision ?? 0 };
    },
  };
}
