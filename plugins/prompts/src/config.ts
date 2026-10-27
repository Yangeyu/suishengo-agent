import { z } from "zod";

const source = { name: z.string().trim().min(1) };
export const promptBindingSchema = z.union([
  z.strictObject({ ...source, version: z.number().int().positive() }),
  z.strictObject({ ...source, label: z.string().trim().min(1) }),
]);

export const promptsOptionsSchema = z.strictObject({
  bindings: z.record(z.string(), promptBindingSchema).default({}),
  cacheTtlSeconds: z.number().int().nonnegative().default(60),
});
export type PromptsOptions = z.infer<typeof promptsOptionsSchema>;
export type PromptBinding = z.infer<typeof promptBindingSchema>;
