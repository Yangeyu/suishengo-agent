import { pipeline } from "@flow";
import {
  createPromptTemplate,
  definePrompt,
  type PromptDefinition,
  type PromptReference,
  type PromptTemplate,
  type Prompts,
} from "@harness/prompts";
import type { PromptsOptions, PromptBinding } from "@plugins/prompts/src/config";

type LoadTemplate = (
  source: PromptBinding,
) => Promise<{ text: string; reference: PromptReference }>;
type BoundPrompt = () => PromptTemplate | Promise<PromptTemplate>;

/** Bind the enabled module catalog once; resolve a fresh version snapshot for each run. */
export function createPrompts(
  definitions: readonly PromptDefinition[],
  bindings: PromptsOptions["bindings"],
  loadRemote?: LoadTemplate,
): Prompts {
  const catalog = definitions.map(definePrompt);
  const keys = new Set(catalog.map((definition) => definition.key));
  if (keys.size !== catalog.length) throw new Error("Duplicate prompt definition");
  for (const key of Object.keys(bindings)) {
    if (!keys.has(key)) throw new Error("Prompt binding has no enabled consumer: " + key);
  }

  const sources = structuredClone(bindings);
  const bound = catalog.map((definition) =>
    bindPrompt(definition, sources[definition.key], loadRemote),
  );
  const resolve = pipeline(
    (signal: AbortSignal) => resolveTemplates(bound, signal),
    (templates) =>
      Object.freeze(Object.fromEntries(templates.map((template) => [template.key, template]))),
  );

  return { resolve: (signal) => resolve(signal, { signal }) };
}

/** Local and remote are explicit choices; a configured remote never falls back to local text. */
function bindPrompt(
  definition: PromptDefinition,
  source: PromptBinding | undefined,
  loadRemote: LoadTemplate | undefined,
): BoundPrompt {
  if (!source) {
    const template = createPromptTemplate(definition, definition.defaultTemplate);
    return () => template;
  }
  if (!loadRemote) throw new Error("Remote prompt requires Langfuse");

  return async () => {
    const remote = await loadRemote(source);
    return createPromptTemplate(definition, remote.text, remote.reference);
  };
}

async function resolveTemplates(bound: readonly BoundPrompt[], signal: AbortSignal) {
  // Join every in-flight load before reporting failure or cancellation.
  const results = await Promise.allSettled(bound.map(async (load) => load()));
  signal.throwIfAborted();

  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
