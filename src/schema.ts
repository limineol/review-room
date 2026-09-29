import { z } from "zod";

export const reviewerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine(
      (name) => !["You", "Review Room"].includes(name),
      "Choose a reviewer name other than You or Review Room",
    ),
  harness: z.enum(["codex", "claude"]),
  model: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
});
export const startSchema = z
  .object({
    repo: z.string().min(1),
    base: z.string().min(1).max(200).default("HEAD"),
    checkpoint: z.string().trim().min(1).max(120),
    task: z.string().trim().min(1).max(8000),
    reviewers: z.array(reviewerSchema).min(2).max(4),
    rounds: z.number().int().min(1).max(3).default(2),
  })
  .refine(
    (value) =>
      new Set(value.reviewers.map((r) => r.name)).size ===
      value.reviewers.length,
    "Reviewer names must be unique",
  );
export type Reviewer = z.infer<typeof reviewerSchema>;
export type Start = z.infer<typeof startSchema>;
export const messageSchema = z.object({
  id: z.number(),
  speaker: z.string(),
  round: z.number(),
  text: z.string(),
  time: z.string(),
});
export const runSchema = z.object({
  id: z.string(),
  config: startSchema,
  status: z.enum([
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  fingerprint: z.string(),
  created: z.string(),
  messages: z.array(messageSchema),
});
export type Run = z.infer<typeof runSchema>;
export const harnessSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  runnable: z.boolean(),
  models: z.array(z.string()),
  modelSource: z.string(),
});
export const stateSchema = z.object({
  harnesses: z.array(harnessSchema),
  runs: z.array(runSchema),
});
