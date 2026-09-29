import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import {
  OpenAIExtensions,
  type OpenAIUiResourceMetadata,
  type OpenAIUiToolMetadata,
} from "@openai/mcp-extensions/server";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { discover } from "./discovery";
import { Store } from "./store";
import { Reviews } from "./runner";
import { startSchema } from "./schema";

const server = new McpServer({ name: "review-room", version: "0.1.0" });
new OpenAIExtensions(server);
const store = new Store(process.env.REVIEW_ROOM_DB);
const reviews = new Reviews(store);
const uri = "ui://review-room/panel";
const state = async () => ({ harnesses: await discover(), runs: store.list() });
const result = (data: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: { ...data },
});
registerAppResource(server, "review-room-panel", uri, {}, async () => ({
  contents: [
    {
      uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL("./panel.html", import.meta.url), "utf8"),
      _meta: {
        "openai/ui": {
          preferredDisplayMode: "fullscreen",
          availableDisplayModes: ["fullscreen"],
        } satisfies OpenAIUiResourceMetadata,
      },
    },
  ],
}));
registerAppTool(
  server,
  "open_review_room",
  {
    title: "Review discussion",
    description:
      "Open Review Room to discover local harnesses, choose models, and start a checkpoint review.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: uri },
      "openai/ui": {
        entrypoints: [{ type: "global" }, { type: "thread" }],
      } satisfies OpenAIUiToolMetadata,
    },
  },
  async () => result(await state()),
);
server.registerTool(
  "review_room_state",
  {
    description:
      "List installed harnesses, model suggestions and recent review discussions. Executable presence is not authentication.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => result(await state()),
);
server.registerTool(
  "start_checkpoint_review",
  {
    description:
      "Start a review using the exact harnesses and models the user chose. Requires two to four named reviewers. Captures tracked changes against base plus untracked text files. Sends that code through their local CLI accounts. Ask the user to select models before calling.",
    inputSchema: startSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (config) => result(await reviews.start(config)),
);
server.registerTool(
  "get_checkpoint_review",
  {
    description: "Read a review discussion and status.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => result(store.get(id)),
);
server.registerTool(
  "message_checkpoint_review",
  {
    description:
      "Add user guidance to a running review; it is delivered to subsequent reviewer turns.",
    inputSchema: {
      id: z.string().uuid(),
      text: z.string().trim().min(1).max(4000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ id, text }) => {
    if (store.get(id).status !== "running")
      throw new Error(
        "This review has ended. Start a new checkpoint to continue.",
      );
    store.message(id, "You", 0, text);
    return result(store.get(id));
  },
);
server.registerTool(
  "stop_checkpoint_review",
  {
    description: "Stop a running review.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ id }) => result(reviews.stop(id)),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    reviews.shutdown();
    setTimeout(() => process.exit(0), 500);
  });
process.stdin.on("end", () => {
  reviews.shutdown();
  setTimeout(() => process.exit(0), 500);
});
await server.connect(new StdioServerTransport());
