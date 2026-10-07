import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { executable } from "./discovery";
import { modelSchema } from "./schema";
import { openCodeEnvironment, piIsolation } from "./harness-policy";

import {
  type HarnessId,
  type ModelChoice,
  type Catalog,
} from "./model-picker-schema";
const frameSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  type: z.string().optional(),
  response: z
    .object({
      subtype: z.string(),
      request_id: z.string(),
      response: z.unknown().optional(),
    })
    .optional(),
});
const codexPage = z.object({
  data: z.array(
    z.object({
      model: modelSchema,
      displayName: z.string(),
      description: z.string().optional(),
      hidden: z.boolean().optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
const claudeCatalog = z.object({
  models: z.array(
    z.object({
      value: modelSchema,
      displayName: z.string(),
      description: z.string(),
    }),
  ),
});

const extraModel = z.object({
  id: modelSchema,
  name: z.string(),
  provider: z.string(),
  contextWindow: z.number().optional(),
});
const piCatalog = z.object({
  type: z.literal("response"),
  command: z.literal("get_available_models"),
  success: z.literal(true),
  data: z.object({ models: z.array(extraModel) }),
});
const openCodeModel = z.object({
  id: modelSchema,
  providerID: z.string(),
  name: z.string(),
  limit: z.object({ context: z.number().optional() }).optional(),
  capabilities: z.object({ toolcall: z.boolean().optional() }).optional(),
});
export function parseOpenCodeModels(output: string): ModelChoice[] {
  const choices: ModelChoice[] = [];
  let id: string | undefined;
  let json: string[] = [];
  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    if (!id) {
      if (line.trim()) id = modelSchema.parse(line.trim());
      continue;
    }
    json.push(line);
    if (line.trimEnd() !== "}") continue;
    const model = openCodeModel.parse(JSON.parse(json.join("\n")));
    if (id !== `${model.providerID}/${model.id}`)
      throw new Error("Model identifier mismatch");
    if (model.capabilities?.toolcall !== false)
      choices.push({
        id,
        name: model.name,
        description:
          model.providerID +
          (model.limit?.context
            ? ` · ${model.limit.context.toLocaleString("en-US")} context tokens`
            : ""),
      });
    id = undefined;
    json = [];
  }
  if (id || json.length) throw new Error("Incomplete model catalog");
  return choices;
}
export async function readCatalog(
  harness: HarnessId,
  command?: string,
  timeoutMs = 15000,
): Promise<ModelChoice[]> {
  const path = command ?? (await executable(harness));
  if (!path) throw new Error(`${harness} is not installed.`);
  const cwd = await mkdtemp(join(tmpdir(), "review-room-models-"));
  try {
    return await new Promise<ModelChoice[]>((resolve, reject) => {
      const child = spawn(
        path,
        harness === "codex"
          ? ["app-server"]
          : harness === "opencode"
            ? ["models", "--pure", "--verbose"]
            : harness === "pi"
              ? ["--mode", "rpc", ...piIsolation, "--no-tools", "--no-session"]
              : [
                  "-p",
                  "--input-format",
                  "stream-json",
                  "--output-format",
                  "stream-json",
                  "--verbose",
                  "--safe-mode",
                  "--strict-mcp-config",
                  "--tools",
                  "",
                  "--no-session-persistence",
                ],
        {
          cwd,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            ...(harness === "opencode" ? openCodeEnvironment : {}),
            PI_TELEMETRY: "0",
          },
        },
      );
      let settled = false,
        buffer = "",
        bytes = 0,
        page = 0;
      const choices: ModelChoice[] = [];
      const cursors = new Set<string>();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.pid) {
          try {
            if (process.platform === "win32") child.kill("SIGKILL");
            else process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
        if (error) reject(error);
        else resolve([...new Map(choices.map((c) => [c.id, c])).values()]);
      };
      const send = (data: object) =>
        child.stdin.write(JSON.stringify(data) + "\n");
      const nextPage = (cursor?: string) => {
        page++;
        send({
          id: `models-${page}`,
          method: "model/list",
          params: {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          },
        });
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Model catalog timed out. Check the harness sign-in and retry.",
            ),
          ),
        timeoutMs,
      );
      child.on("error", () => finish(new Error(`Could not start ${harness}.`)));
      child.on("close", (code) => {
        if (settled) return;
        if (harness === "opencode" && code === 0) {
          try {
            choices.push(...parseOpenCodeModels(buffer));
            finish();
          } catch {
            finish(
              new Error(
                "OpenCode returned an unsupported model catalog response.",
              ),
            );
          }
        } else
          finish(
            new Error(`${harness} closed before returning its model catalog.`),
          );
      });
      child.stdin.on("error", () =>
        finish(new Error(`${harness} closed its catalog connection.`)),
      );
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000)
          finish(new Error("Model catalog exceeded the output limit."));
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > 2_000_000)
          return finish(new Error("Model catalog exceeded the output limit."));
        buffer += chunk;
        if (harness === "opencode") return;
        let newline: number;
        while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const value: unknown = JSON.parse(line);
            if (harness === "pi") {
              const response = z
                .object({ type: z.string(), command: z.string().optional() })
                .parse(value);
              if (
                response.type !== "response" ||
                response.command !== "get_available_models"
              )
                continue;
              choices.push(
                ...piCatalog
                  .parse(value)
                  .data.models.map((m) => ({
                    id: modelSchema.parse(`${m.provider}/${m.id}`),
                    name: m.name,
                    description:
                      m.provider +
                      (m.contextWindow
                        ? ` · ${m.contextWindow.toLocaleString("en-US")} context tokens`
                        : ""),
                  })),
              );
              finish();
              continue;
            }
            const frame = frameSchema.parse(value);
            if (harness === "claude") {
              if (
                frame.type !== "control_response" ||
                frame.response?.request_id !== "catalog"
              )
                continue;
              if (frame.response.subtype !== "success")
                throw new Error("Catalog rejected");
              choices.push(
                ...claudeCatalog
                  .parse(frame.response.response)
                  .models.map((m) => ({
                    id: m.value,
                    name: m.displayName,
                    description: m.description,
                  })),
              );
              finish();
            } else if (frame.id === "init") {
              if (frame.error) throw new Error("Initialize rejected");
              send({ method: "initialized" });
              nextPage();
            } else if (frame.id === `models-${page}`) {
              if (frame.error) throw new Error("Catalog rejected");
              const data = codexPage.parse(frame.result);
              choices.push(
                ...data.data
                  .filter((m) => !m.hidden)
                  .map((m) => ({
                    id: m.model,
                    name: m.displayName,
                    description: m.description ?? "",
                  })),
              );
              if (!data.nextCursor) finish();
              else {
                if (page >= 20 || cursors.has(data.nextCursor))
                  throw new Error("Invalid pagination");
                cursors.add(data.nextCursor);
                nextPage(data.nextCursor);
              }
            }
          } catch {
            finish(
              new Error(
                `${harness} returned an unsupported model catalog response. Update the harness and retry.`,
              ),
            );
          }
        }
      });
      if (harness === "codex")
        send({
          id: "init",
          method: "initialize",
          params: {
            clientInfo: {
              name: "review_room",
              title: "Review Room",
              version: "0.4.0",
            },
          },
        });
      else if (harness === "pi")
        send({ id: "catalog", type: "get_available_models" });
      else if (harness === "opencode") child.stdin.end();
      else
        send({
          request_id: "catalog",
          type: "control_request",
          request: { subtype: "initialize" },
        });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export class ModelCatalogs {
  private cache = new Map<HarnessId, { catalog: Catalog; expires: number }>();
  private pending = new Map<HarnessId, Promise<Catalog>>();
  constructor(private read = readCatalog) {}
  async get(harness: HarnessId, refresh = false): Promise<Catalog> {
    const pending = this.pending.get(harness);
    if (pending) return pending;
    const cached = this.cache.get(harness);
    if (!refresh && cached && Date.now() < cached.expires)
      return cached.catalog;
    const request = this.read(harness)
      .then((choices) => {
        const catalog = { choices, stale: false };
        this.cache.set(harness, { catalog, expires: Date.now() + 60_000 });
        return catalog;
      })
      .catch(() => {
        const catalog = {
          choices: cached?.catalog.choices ?? [],
          stale: true,
          error: `Could not refresh ${harness} models. Check that the harness is installed and signed in, then retry. Existing selections are preserved.`,
        };
        this.cache.set(harness, { catalog, expires: Date.now() + 10_000 });
        return catalog;
      })
      .finally(() => this.pending.delete(harness));
    this.pending.set(harness, request);
    return request;
  }
}
