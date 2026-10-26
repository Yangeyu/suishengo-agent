import { z } from "zod";
import { Check } from "typebox/value";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { OpenAICompletionsCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";

export const piModelOptionsSchema = z
  .strictObject({
    provider: z.string().min(1),
    baseUrl: z.url(),
    modelId: z.string().min(1),
    apiKey: z.string().min(1),
    contextWindow: z.number().int().min(1024).max(10000000),
    maxOutputTokens: z.number().int().positive(),
    reasoning: z.boolean().default(false),
    compat: z
      .custom<OpenAICompletionsCompat>(
        (value) => Check(OpenAICompletionsCompatSchema, value),
        "Invalid OpenAI completions compatibility options",
      )
      .optional(),
  })
  .refine((model) => model.maxOutputTokens < model.contextWindow, {
    message: "Model output limit must be smaller than the context window",
    path: ["maxOutputTokens"],
  });
export type PiModelOptions = z.infer<typeof piModelOptionsSchema>;
