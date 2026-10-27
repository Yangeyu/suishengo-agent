import type { LangfuseClient } from "@langfuse/client";
import type { PromptBinding } from "@plugins/prompts/src/config";

export async function loadLangfusePrompt(
  client: LangfuseClient,
  source: PromptBinding,
  cacheTtlSeconds: number,
) {
  const prompt = await client.prompt.get(source.name, {
    type: "text",
    ...("version" in source ? { version: source.version } : { label: source.label }),
    cacheTtlSeconds,
    fetchTimeoutMs: 5000,
    maxRetries: 0,
  });

  if (prompt.isFallback) throw new Error("Configured prompt is unavailable");
  if (
    prompt.name !== source.name ||
    !Number.isInteger(prompt.version) ||
    prompt.version < 1 ||
    ("version" in source && prompt.version !== source.version)
  )
    throw new Error("Resolved prompt version does not match binding: " + source.name);

  return {
    text: prompt.prompt,
    reference: { name: prompt.name, version: prompt.version },
  };
}
