import { z } from "zod";
import { realpathSync } from "node:fs";
import { replySchema, type Reply } from "./schema";
import type { Invocation, InvocationResult } from "./harness";
import {
  openCodeEnvironment,
  piGuardPath,
  piIsolation,
  piSessionDirectory,
} from "./harness-policy";
const jsonSchema = JSON.stringify(
  z.toJSONSchema(replySchema, { target: "draft-7" }),
);
const envelope = z.object({ type: z.string() }).passthrough();
const codexEvent = z.object({
  type: z.string(),
  thread_id: z.string().optional(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
});
const claudeEvent = z.object({
  type: z.string(),
  session_id: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  message: z
    .object({
      content: z.array(
        z.object({ type: z.string(), name: z.string().optional() }),
      ),
    })
    .optional(),
});
const openCodeEvent = z.object({
  error: z
    .object({
      name: z.string().optional(),
      data: z
        .object({
          message: z.string().optional(),
          statusCode: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  type: z.string(),
  sessionID: z.string().optional(),
  part: z
    .object({ text: z.string().optional(), tool: z.string().optional() })
    .optional(),
});
const piResponse = z.object({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
});
const piCommands = z.object({
  commands: z.array(
    z.object({
      name: z.string(),
      source: z.string(),
      sourceInfo: z.object({ path: z.string() }).optional(),
    }),
  ),
});
const piState = z.object({
  sessionId: z.string().uuid(),
  messageCount: z.number().int().min(0),
});
const piMessage = z.object({
  message: z.object({
    role: z.literal("assistant"),
    stopReason: z.string().optional(),
    content: z.array(
      z.object({ type: z.string(), text: z.string().optional() }),
    ),
  }),
});
export type WriteCommand = (value: object) => void;

export function redactDiagnostic(message: string) {
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:sk-|gh[pousr]_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(
      /(authorization|x-api-key|api[_-]?key|access_token|refresh_token)["']?\s*[:=]\s*["']?[^\s,"';]+/gi,
      "$1: [redacted]",
    )
    .replace(/https?:\/\/[^\s"<>]+/g, "[provider URL]")
    .replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "[redacted email]",
    )
    .replace(/[A-Za-z0-9_+\/=-]{32,}/g, "[redacted token]");
}
function sameGuardPath(path: string | undefined) {
  if (!path) return false;
  try {
    return realpathSync(path) === realpathSync(piGuardPath);
  } catch {
    return false;
  }
}
export function argumentsFor(input: Invocation): string[] {
  const { reviewer, repo, schemaFile } = input;
  switch (reviewer.harness) {
    case "claude":
      return [
        "-p",
        "--model",
        reviewer.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        jsonSchema,
        "--safe-mode",
        "--restricted",
        "--tools",
        "Read,Grep,Glob",
        "--allowedTools",
        "Read,Grep,Glob",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        ...(reviewer.sessionId
          ? ["--resume", reviewer.sessionId]
          : ["--session-id", crypto.randomUUID()]),
      ];
    case "codex":
      return [
        "exec",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable",
        "plugins",
        "--json",
        "--model",
        reviewer.model,
        "--output-schema",
        schemaFile,
        ...(reviewer.sessionId
          ? ["resume", reviewer.sessionId, "-"]
          : ["-C", repo, "-"]),
      ];
    case "opencode":
      return [
        "run",
        "--pure",
        "--format",
        "json",
        "--model",
        reviewer.model,
        "--agent",
        "review-room",
        "--dir",
        repo,
        "--title",
        "Review Room",
        ...(reviewer.sessionId ? ["--session", reviewer.sessionId] : []),
      ];
    case "pi":
      return [
        "--mode",
        "rpc",
        ...piIsolation,
        "--tools",
        "read,grep,find,ls",
        "--extension",
        piGuardPath,
        "--session-dir",
        piSessionDirectory(input),
        "--session-id",
        reviewer.sessionId ?? crypto.randomUUID(),
        "--model",
        reviewer.model,
        "--name",
        "Review Room",
      ];
  }
}
export function reviewProtocol(input: Invocation) {
  const harness = input.reviewer.harness;
  let reply: Reply | undefined,
    finalText = "",
    sessionId = input.reviewer.sessionId;
  let piFailure = false;
  let piPhase: "guard" | "state" | "review" | "done" = "guard";
  const prompt = `${input.prompt}\n\nReturn only a JSON object matching this schema, with no code fences or surrounding prose:\n${jsonSchema}`;
  return {
    args: argumentsFor(input),
    env:
      harness === "opencode"
        ? openCodeEnvironment
        : harness === "pi"
          ? { REVIEW_ROOM_REPO: input.repo, PI_TELEMETRY: "0" }
          : {},
    prompt: harness === "opencode" ? prompt : input.prompt,
    start(write: WriteCommand) {
      write({ id: "guard", type: "get_commands" });
    },
    consume(
      value: unknown,
      write: WriteCommand,
      activity: (text: string) => void,
    ): boolean {
      const frame = envelope.parse(value);
      if (harness === "codex") {
        const event = codexEvent.parse(frame);
        if (event.thread_id) sessionId = event.thread_id;
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message"
        )
          finalText = event.item.text ?? "";
        if (event.item?.type === "command_execution")
          activity("Inspecting repository with read-only commands");
      } else if (harness === "claude") {
        const event = claudeEvent.parse(frame);
        if (event.session_id) sessionId = event.session_id;
        if (event.type === "result") {
          if (event.is_error)
            throw new Error(event.result ?? "Reviewer failed.");
          reply = replySchema.parse(
            event.structured_output ?? JSON.parse(event.result ?? "null"),
          );
        }
        for (const block of event.message?.content ?? [])
          if (
            block.type === "tool_use" &&
            ["Read", "Grep", "Glob"].includes(block.name ?? "")
          )
            activity(`Using ${block.name} to inspect code`);
      } else if (harness === "opencode") {
        const event = openCodeEvent.parse(frame);
        if (event.sessionID) sessionId = event.sessionID;
        if (event.type === "text") finalText = event.part?.text ?? "";
        if (event.type === "error") {
          const detail = event.error?.data?.message ?? "";
          if (
            /session.{0,80}(?:not found|does not exist)|no session found/i.test(
              detail,
            )
          )
            throw new Error("OpenCode session not found in saved history.");
          if (
            event.error?.data?.statusCode === 401 ||
            /token refresh failed|unauthorized|authentication|invalid api key/i.test(
              detail,
            )
          )
            throw new Error(
              "OpenCode authentication failed. Sign in with opencode auth login and retry.",
            );
          const safe = redactDiagnostic(detail).trim().slice(0, 600);
          throw new Error(
            safe
              ? `OpenCode: ${safe}`
              : "OpenCode could not complete the review. Check the selected model and provider account.",
          );
        }
        if (event.type === "tool_use" && event.part?.tool)
          activity(`Using ${event.part.tool} to inspect code`);
      } else {
        if (frame.type === "response") {
          const event = piResponse.parse(frame);
          if (!event.success)
            throw new Error(
              "Pi rejected a review command. Check the selected model and provider account.",
            );
          if (event.id === "guard" && piPhase === "guard") {
            const commands = piCommands.parse(event.data).commands;
            if (
              !commands.some(
                (c) =>
                  c.name === "review-room-ready" &&
                  c.source === "extension" &&
                  sameGuardPath(c.sourceInfo?.path),
              )
            )
              throw new Error(
                "Pi read-only guard failed to load; review was not started.",
              );
            piPhase = "state";
            write({ id: "state", type: "get_state" });
          } else if (event.id === "state") {
            if (piPhase !== "state")
              throw new Error("Pi read-only guard was not verified.");
            const state = piState.parse(event.data);
            if (input.reviewer.sessionId && state.messageCount === 0)
              throw new Error("Pi session not found in saved history.");
            sessionId = state.sessionId;
            piPhase = "review";
            write({ id: "review", type: "prompt", message: prompt });
          }
        }
        if (frame.type === "message_end") {
          const event = piMessage.safeParse(frame);
          if (event.success) {
            finalText = event.data.message.content
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("");
            piFailure = ["error", "aborted"].includes(
              event.data.message.stopReason ?? "",
            );
          }
        }
        if (frame.type === "tool_execution_start") {
          const tool = z.object({ toolName: z.string() }).parse(frame).toolName;
          activity(`Using ${tool} to inspect code`);
        }
        if (frame.type === "agent_settled" && piPhase === "review") {
          if (piFailure)
            throw new Error(
              "Pi could not complete the review. Check the selected model and provider account.",
            );
          piPhase = "done";
          return true;
        }
      }
      return false;
    },
    result(): InvocationResult {
      if (!reply) {
        if (!finalText)
          throw new Error("Reviewer did not return a review response.");
        try {
          reply = replySchema.parse(JSON.parse(finalText));
        } catch {
          throw new Error("Reviewer returned an invalid structured response.");
        }
      }
      return { reply, sessionId };
    },
  };
}
