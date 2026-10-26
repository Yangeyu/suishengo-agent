import { z } from "zod";

export const runtimeOptionsSchema = z.strictObject({
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  limits: z
    .strictObject({
      maxSteps: z.number().int().min(1).max(50).default(8),
      maxToolCalls: z.number().int().min(1).max(100).default(12),
      maxTokens: z.number().int().min(1).max(1000000).default(32000),
    })
    .prefault({}),
});
