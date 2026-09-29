import { z } from "zod";
export const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
export const reviewerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine(
      (name) => !["agent", "all", "Review Room"].includes(name),
      "Reserved reviewer name",
    ),
  harness: z.enum(["codex", "claude"]),
  model: modelSchema,
});
export type Reviewer = z.infer<typeof reviewerSchema>;
export const settingsSchema = z.object({
  codexEnabled: z.boolean(),
  codexModels: z.string().max(4000),
  claudeEnabled: z.boolean(),
  claudeModels: z.string().max(4000),
  reuseSessions: z.boolean(),
  maxReviewers: z.number().int().min(1).max(4),
  maxTurns: z.number().int().min(1).max(30),
  timeoutSeconds: z.number().int().min(30).max(600),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = {
  codexEnabled: false,
  codexModels: "",
  claudeEnabled: false,
  claudeModels: "",
  reuseSessions: false,
  maxReviewers: 2,
  maxTurns: 12,
  timeoutSeconds: 180,
};
export const startSchema = z
  .object({
    roomId: z.string().uuid().optional(),
    repo: z.string().min(1),
    label: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(12000),
    reviewers: z.array(reviewerSchema).min(1).max(4),
  })
  .refine(
    (v) => new Set(v.reviewers.map((r) => r.name)).size === v.reviewers.length,
    "Reviewer names must be unique",
  );
export type Start = z.infer<typeof startSchema>;
export const replySchema = z.object({
  body: z.string().min(1).max(20000),
  messages: z
    .array(
      z.object({
        to: z.string().min(1).max(60),
        text: z.string().min(1).max(4000),
      }),
    )
    .max(4),
});
export type Reply = z.infer<typeof replySchema>;
export const participantSchema = reviewerSchema.extend({
  sessionId: z.string().nullable(),
  state: z.enum(["idle", "running", "failed"]),
});
export type Participant = z.infer<typeof participantSchema>;
export const messageSchema = z.object({
  id: z.number(),
  sender: z.string(),
  recipient: z.string(),
  kind: z.enum(["message", "activity", "error", "status"]),
  text: z.string(),
  time: z.string(),
});
export type Message = z.infer<typeof messageSchema>;
export const runSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  repo: z.string(),
  label: z.string(),
  prompt: z.string(),
  status: z.enum([
    "running",
    "ready",
    "collecting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  created: z.string(),
  turns: z.number(),
  maxTurns: z.number(),
  artifact: z.string().nullable(),
  reviewers: z.array(participantSchema),
  messages: z.array(messageSchema),
});
export type Run = z.infer<typeof runSchema>;
export const stateSchema = z.object({
  runs: z.array(runSchema),
  selectedRunId: z.string().optional(),
});
export const harnessSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  runnable: z.boolean(),
  models: z.array(z.string()),
  modelSource: z.string(),
});
export function models(text: string) {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((v) => modelSchema.parse(v)),
    ),
  ];
}
export function enabled(settings: Settings, reviewer: Reviewer) {
  return reviewer.harness === "codex"
    ? settings.codexEnabled &&
        models(settings.codexModels).includes(reviewer.model)
    : settings.claudeEnabled &&
        models(settings.claudeModels).includes(reviewer.model);
}
