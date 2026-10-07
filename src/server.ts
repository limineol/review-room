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
import { Reviews, promptGuide } from "./runner";
import {
  startSchema,
  threadTitleSchema,
  settingsSchema,
  modelSchema,
  models,
  summarize,
} from "./schema";
import { ModelSettings, nativeSettingsSchema } from "./model-settings";
import { harnessId } from "./model-picker-schema";
const version = "0.3.2";
const server = new McpServer({ name: "review-room", version });
const extensions = new OpenAIExtensions(server);
const store = new Store(process.env.REVIEW_ROOM_DB);
const modelSettings = new ModelSettings(store);
const reviews = new Reviews(store, undefined, process.env.REVIEW_ROOM_DATA);
const html = await readFile(new URL("./panel.html", import.meta.url), "utf8");
const uri = "ui://review-room/panel-v2";
const result = (data: object) => ({
  content: [
    {
      type: "text" as const,
      text: "Review Room result is available in structuredContent.",
    },
  ],
  structuredContent: { ...data },
});
extensions.settings?.register({
  fields: {
    codexEnabled: {
      schema: settingsSchema.shape.codexEnabled,
      title: "Enable Codex",
    },
    claudeEnabled: {
      schema: settingsSchema.shape.claudeEnabled,
      title: "Enable Claude Code",
    },
    reuseSessions: {
      schema: settingsSchema.shape.reuseSessions,
      title: "Reuse reviewer sessions between cycles",
      description:
        "Off by default. Sessions still continue for dialogue within each cycle. Reuse is scoped to this review room and repository.",
    },
    maxReviewers: {
      schema: settingsSchema.shape.maxReviewers,
      title: "Maximum reviewers per cycle",
    },
    maxTurns: {
      schema: settingsSchema.shape.maxTurns,
      title: "Maximum reviewer turns per cycle",
    },
    timeoutSeconds: {
      schema: settingsSchema.shape.timeoutSeconds,
      title: "Seconds allowed per reviewer turn",
    },
  },
  layout: [
    {
      kind: "group",
      title: "Harnesses and models",
      items: [
        { kind: "property", property: "codexEnabled" },
        {
          kind: "tool",
          tool: "choose_codex_models",
          title: "Choose Codex models…",
        },
        { kind: "property", property: "claudeEnabled" },
        {
          kind: "tool",
          tool: "choose_claude_models",
          title: "Choose Claude models…",
        },
      ],
    },
    {
      kind: "group",
      title: "Review sessions",
      items: [
        { kind: "property", property: "reuseSessions" },
        { kind: "property", property: "maxReviewers" },
        { kind: "property", property: "maxTurns" },
        { kind: "property", property: "timeoutSeconds" },
      ],
    },
  ],
  read: () => nativeSettingsSchema.parse(store.settings()),
  update: (set) => nativeSettingsSchema.parse(store.updateSettings(set)),
});
const pickerUri = "ui://review-room/model-picker";
const pickerHtml = await readFile(
  new URL("./model-picker.html", import.meta.url),
  "utf8",
);
registerAppResource(server, "model-picker", pickerUri, {}, async () => ({
  contents: [
    {
      uri: pickerUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: pickerHtml,
      _meta: {
        "openai/ui": {
          preferredDisplayMode: "fullscreen",
          availableDisplayModes: ["fullscreen"],
        } satisfies OpenAIUiResourceMetadata,
      },
    },
  ],
}));
for (const harness of ["codex", "claude"] as const) {
  registerAppTool(
    server,
    `choose_${harness}_models`,
    {
      title: `Choose ${harness === "codex" ? "Codex" : "Claude"} models`,
      description: "Choose allowed reviewer models in plugin Settings.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: pickerUri, visibility: ["app"] } },
    },
    async () => result(await modelSettings.read(harness)),
  );
}
server.registerTool(
  "review_models_read",
  {
    inputSchema: { harness: harnessId, refresh: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ harness, refresh }) =>
    result(await modelSettings.read(harness, refresh)),
);
server.registerTool(
  "review_models_save",
  {
    inputSchema: {
      harness: harnessId,
      selected: z.array(modelSchema).max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ harness, selected }) =>
    result(await modelSettings.save(harness, selected)),
);
registerAppResource(server, "review-room-panel", uri, {}, async () => ({
  contents: [
    {
      uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: html,
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
      "Open the live review discussion beside this chat. Pass the runId returned by review_start to show that cycle.",
    inputSchema: { runId: z.string().uuid().optional() },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: uri },
      "openai/ui": {
        entrypoints: [{ type: "global" }, { type: "thread" }],
      } satisfies OpenAIUiToolMetadata,
    },
  },
  async ({ runId }) =>
    result({
      runs: store.list().map(summarize),
      ...(runId ? { selectedRunId: runId } : {}),
    }),
);
server.registerTool(
  "review_discover",
  {
    description:
      "Discover installed harnesses and model combinations enabled in native plugin settings. The agent selects among the enabled combinations; installation does not verify account access.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const settings = store.settings();
    const harnesses = await Promise.all(
      (await discover()).map(async (h) => {
        if (h.id !== "codex" && h.id !== "claude") return h;
        if (!settings[`${h.id}Enabled`]) return h;
        const catalog = await modelSettings.read(h.id);
        return {
          ...h,
          models: catalog.choices.map((m) => m.id),
          modelChoices: catalog.choices,
          modelSource:
            "Harness model catalog; account access is checked when run",
          catalogError: catalog.error,
          catalogStale: catalog.stale,
        };
      }),
    );
    return result({
      version,
      settings,
      harnesses,
      enabled: harnesses
        .filter((h) => h.runnable)
        .flatMap((h) =>
          h.id === "codex" && settings.codexEnabled
            ? models(settings.codexModels).map((model) => ({
                harness: "codex",
                model,
              }))
            : h.id === "claude" && settings.claudeEnabled
              ? models(settings.claudeModels).map((model) => ({
                  harness: "claude",
                  model,
                }))
              : [],
        ),
    });
  },
);
server.registerTool(
  "review_prompt_guide",
  {
    description:
      "Learn how to prompt reviewers and drive the agent-controlled review loop.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: "text", text: promptGuide }] }),
);
server.registerTool(
  "review_start",
  {
    description:
      "Start background reviewers on the live repository. The chat agent chooses enabled harness/model combinations and writes the prompt. Reuse this chat’s roomId for later cycles, or omit it for the first cycle. No frozen snapshot is created. Include the current chat title in threadTitle only when the host exposes it. Otherwise omit the field; do not guess from the repository or review label.",
    inputSchema: startSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (config) => result(summarize(await reviews.start(config))),
);
server.registerTool(
  "review_set_thread_title",
  {
    description:
      "Record the originating chat title for all review cycles in this room. Use a verified title from the current chat; this labels review history and does not rename the chat.",
    inputSchema: { roomId: z.string().uuid(), threadTitle: threadTitleSchema },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ roomId, threadTitle }) =>
    result(store.setThreadTitle(roomId, threadTitle)),
);
server.registerTool(
  "review_send",
  {
    description:
      "Send the chat agent’s question or feedback to one reviewer by exact name, or all. Reviewers can route their own questions to peers and back to the agent.",
    inputSchema: {
      runId: z.string().uuid(),
      to: z.string().min(1).max(60),
      text: z.string().trim().min(1).max(12000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ runId, to, text }) =>
    result(summarize(reviews.send(runId, to, text))),
);
server.registerTool(
  "review_wait",
  {
    description:
      "Wait up to 60 seconds for published messages or a state change. Pass the cursor from the last response as after. This keeps orchestration in the active chat; it does not wake an idle chat.",
    inputSchema: {
      runId: z.string().uuid(),
      after: z.number().int().min(0).default(0),
      seconds: z.number().int().min(0).max(60).default(30),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ runId, after, seconds }, extra) =>
    result(await reviews.wait(runId, after, seconds, extra.signal)),
);
server.registerTool(
  "review_collect",
  {
    description:
      "When reviewers are idle or the cycle has ended, collect a Markdown artifact including any partial findings or failures. The agent evaluates it, implements appropriate feedback, and may start another cycle.",
    inputSchema: { runId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ runId }) => result(await reviews.collect(runId)),
);
server.registerTool(
  "review_read",
  {
    description:
      "Read a review cycle and up to six published messages after a cursor, including terminal errors.",
    inputSchema: {
      runId: z.string().uuid(),
      after: z.number().int().min(0).default(0),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ runId, after }) =>
    result({
      run: summarize(store.get(runId, false)),
      ...store.page(runId, after),
    }),
);
server.registerTool(
  "review_stop",
  {
    description: "Cancel a review cycle and stop active reviewers.",
    inputSchema: { runId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ runId }) => result(summarize(reviews.stop(runId))),
);
server.registerTool(
  "review_room_state",
  {
    description: "Read review summaries for the panel.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] } },
  },
  async () => result({ runs: store.list().map(summarize) }),
);
server.registerTool(
  "review_room_discussion",
  {
    description: "Read a full discussion for the panel.",
    inputSchema: { runId: z.string().uuid() },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ runId }) => result(store.get(runId)),
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
