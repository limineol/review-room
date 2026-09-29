import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { executable } from "./discovery";
import { replySchema, type Participant, type Reply } from "./schema";
export type Invocation = {
  reviewer: Participant;
  repo: string;
  prompt: string;
  schemaFile: string;
  timeoutSeconds: number;
  signal: AbortSignal;
  activity: (text: string) => void;
};
export type InvocationResult = { reply: Reply; sessionId: string | null };
export type Invoke = (input: Invocation) => Promise<InvocationResult>;
const jsonSchema = JSON.stringify(
  z.toJSONSchema(replySchema, { target: "draft-7" }),
);
export async function writeReplySchema(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "reply-schema.json");
  await writeFile(path, jsonSchema, { mode: 0o600 });
  return path;
}
export function argumentsFor(input: Invocation): string[] {
  const { reviewer, repo, schemaFile } = input;
  if (reviewer.harness === "claude")
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
}
const eventSchema = z.object({
  type: z.string(),
  session_id: z.string().optional(),
  thread_id: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
  message: z
    .object({
      content: z.array(
        z.object({
          type: z.string(),
          name: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    })
    .optional(),
});
export const invoke: Invoke = async (input) => {
  const command = await executable(input.reviewer.harness);
  input.signal.throwIfAborted();
  if (!command) throw new Error(`${input.reviewer.harness} is not installed.`);
  return await new Promise<InvocationResult>((resolve, reject) => {
    const child = spawn(command, argumentsFor(input), {
      cwd: input.repo,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: undefined },
    });
    let buffer = "",
      errors = "",
      bytes = 0,
      failure: Error | undefined,
      reply: Reply | undefined,
      sessionId = input.reviewer.sessionId;
    const shown = new Set<string>();
    const activity = (text: string) => {
      if (!shown.has(text)) {
        shown.add(text);
        input.activity(text);
      }
    };
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          failure = new Error("Could not stop reviewer process.");
      }
    };
    const abort = () => stop("Review cancelled");
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => stop("Reviewer time limit exceeded"),
      input.timeoutSeconds * 1000,
    );
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const parsed = eventSchema.safeParse(JSON.parse(line));
        if (!parsed.success) return;
        const event = parsed.data;
        if (event.thread_id) sessionId = event.thread_id;
        if (event.session_id) sessionId = event.session_id;
        if (event.type === "result") {
          if (event.is_error)
            failure = new Error(event.result ?? "Reviewer failed.");
          else
            reply = replySchema.parse(
              event.structured_output ?? JSON.parse(event.result ?? "null"),
            );
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message"
        )
          reply = replySchema.parse(JSON.parse(event.item.text ?? "null"));
        if (event.item?.type === "command_execution")
          activity("Inspecting repository with read-only commands");
        for (const block of event.message?.content ?? [])
          if (
            block.type === "tool_use" &&
            ["Read", "Grep", "Glob"].includes(block.name ?? "")
          )
            activity(`Using ${block.name} to inspect code`);
      } catch (error) {
        if (error instanceof SyntaxError) return;
        failure = new Error(
          "Reviewer returned an invalid structured response.",
        );
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2000000) {
        stop("Reviewer output exceeded 2 MB");
        return;
      }
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      consume(buffer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            errors
              .split("\n")
              .filter((l) => /^ERROR:|^Error:/.test(l))
              .at(-1) ?? `Reviewer exited ${code}: ${errors.slice(-500)}`,
          ),
        );
      else if (!reply)
        reject(new Error("Reviewer did not return a review response."));
      else resolve({ reply, sessionId });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.prompt);
  });
};
