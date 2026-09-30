import { z } from "zod";
import { modelSchema, reviewerSchema } from "./schema";
export const harnessId = reviewerSchema.shape.harness;
export type HarnessId = z.infer<typeof harnessId>;
export const choiceSchema = z.object({
  id: modelSchema,
  name: z.string(),
  description: z.string(),
});
export type ModelChoice = z.infer<typeof choiceSchema>;
export const catalogSchema = z.object({
  choices: z.array(choiceSchema),
  stale: z.boolean(),
  error: z.string().optional(),
});
export type Catalog = z.infer<typeof catalogSchema>;
export const pickerSchema = catalogSchema.extend({
  harness: harnessId,
  selected: z.array(modelSchema),
});
