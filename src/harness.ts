import { spawn } from "node:child_process";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { executable } from "./discovery";
import { prepareOpenCode } from "./opencode-preflight";
import { redactDiagnostic, reviewProtocol } from "./review-protocol";
import { piSessionDirectory } from "./harness-policy";
export { argumentsFor } from "./review-protocol";
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
export class MissingSessionError extends Error {}
const jsonSchema = JSON.stringify(
  z.toJSONSchema(replySchema, { target: "draft-7" }),
);
export async function writeReplySchema(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256")
    .update(jsonSchema)
    .digest("hex")
    .slice(0, 16);
  const path = join(directory, `reply-schema-${hash}.json`);
  const temporary = join(directory, `.reply-schema-${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, jsonSchema, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}
export const invoke: Invoke = async (input) => {
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  const command = await executable(input.reviewer.harness);
  input.signal.throwIfAborted();
  if (!command) throw new Error(`${input.reviewer.harness} is not installed.`);
  if (input.reviewer.harness === "pi")
    await mkdir(piSessionDirectory(input), { recursive: true, mode: 0o700 });
  const protocol = reviewProtocol(input);
  const prepared =
    input.reviewer.harness === "opencode"
      ? await prepareOpenCode(command, input.repo, input.signal, deadline)
      : {};
  input.signal.throwIfAborted();
  if (Date.now() >= deadline) throw new Error("Reviewer time limit exceeded");
  return await new Promise<InvocationResult>((resolve, reject) => {
    const child = spawn(command, protocol.args, {
      cwd: input.repo,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        ...protocol.env,
        ...prepared,
      },
    });
    let buffer = "",
      errors = "",
      bytes = 0,
      failure: Error | undefined,
      completed: InvocationResult | undefined,
      closeTimeout: ReturnType<typeof setTimeout> | undefined;
    const shown = new Set<string>();
    const activity = (text: string) => {
      if (!shown.has(text)) {
        shown.add(text);
        input.activity(text);
      }
    };
    const terminate = () => {
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
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      terminate();
    };
    const abort = () => stop("Review cancelled");
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => stop("Reviewer time limit exceeded"),
      Math.max(1, deadline - Date.now()),
    );
    const write = (value: object) =>
      child.stdin.write(JSON.stringify(value) + "\n");
    const consume = (line: string) => {
      if (!line.trim() || failure || completed) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      try {
        if (protocol.consume(event, write, activity)) {
          completed = protocol.result();
          clearTimeout(timeout);
          child.stdin.end();
          closeTimeout = setTimeout(
            terminate,
            Math.max(1, Math.min(3000, deadline - Date.now())),
          );
        }
      } catch (error) {
        stop(
          error instanceof Error
            ? redactDiagnostic(error.message)
            : "Reviewer returned an invalid response.",
        );
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (completed) return;
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
      if (!completed) failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(closeTimeout);
      input.signal.removeEventListener("abort", abort);
      consume(buffer);
      if (!failure && !completed && code !== 0)
        failure = new Error(
          redactDiagnostic(errors)
            .split("\n")
            .filter((l) => /^ERROR:|^Error:/.test(l))
            .at(-1) ??
            `Reviewer exited ${code}: ${redactDiagnostic(errors).slice(-500)}`,
        );
      if (failure) {
        const missing =
          /no (?:conversation|session|saved rollout) (?:was )?found|(?:session|conversation).{0,80}(?:not found|does not exist)/i.test(
            failure.message,
          );
        reject(
          input.reviewer.sessionId && missing
            ? new MissingSessionError(failure.message)
            : failure,
        );
      } else {
        try {
          resolve(completed ?? protocol.result());
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.on("error", () => {});
    if (input.reviewer.harness === "pi") protocol.start(write);
    else child.stdin.end(protocol.prompt);
  });
};
