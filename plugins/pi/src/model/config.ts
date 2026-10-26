import { z } from "zod";
import { bailianConnectionSchema, bailianModels } from "@plugins/pi/src/model/providers/bailian";

export const piModelSelectionSchema = z
  .strictObject({
    provider: z.literal("dashscope"),
    modelId: z.string().min(1),
    maxOutputTokens: z.number().int().positive(),
  })
  .superRefine((selection, ctx) => {
    const model = bailianModels.find((model) => model.id === selection.modelId);
    if (!model) {
      ctx.addIssue({ code: "custom", path: ["modelId"], message: "Unknown DashScope model" });
    } else if (
      selection.maxOutputTokens > model.maxTokens ||
      selection.maxOutputTokens >= model.contextWindow
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxOutputTokens"],
        message: "Model output limit exceeds the supported model capability",
      });
    }
  });

export const piModelOptionsSchema = piModelSelectionSchema
  .safeExtend(bailianConnectionSchema.shape)
  .transform((options) => ({
    ...options,
    contextWindow: bailianModels.find((model) => model.id === options.modelId)!.contextWindow,
  }));
