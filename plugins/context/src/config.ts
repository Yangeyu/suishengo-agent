import { z } from "zod";

export const compactionPolicySchema = z.strictObject({
  version: z.string().min(1).default("summary-v1"),
  triggerFraction: z.number().gt(0).lt(1).default(0.7),
  keepRecentTurns: z.number().int().min(1).default(2),
  maxSummaryTokens: z.number().int().positive().default(1024),
});
export type CompactionPolicy = z.infer<typeof compactionPolicySchema>;

export const contextOptionsSchema = z.strictObject({
  compaction: z.union([z.literal(false), compactionPolicySchema]).default(false),
});
export type ContextOptions = z.infer<typeof contextOptionsSchema>;

export function validateContextOptions(options: ContextOptions, contextWindow: number) {
  if (options.compaction && options.compaction.maxSummaryTokens >= contextWindow)
    throw new Error("Summary limit must be smaller than the context window");
}
