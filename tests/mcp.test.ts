import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateSchema, runSchema } from "../src/schema";
import { Store } from "../src/store";

test("built MCP server exposes both entrypoints, serves its bundled panel, and discovers harnesses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-room-mcp-"));
  const client = new Client({ name: "review-room-test", version: "1.0.0" });
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/server.js"],
        env: { ...env, REVIEW_ROOM_DB: join(dir, "state.sqlite") },
        stderr: "pipe",
      }),
    );
    const list = await client.listTools();
    const opener = list.tools.find((t) => t.name === "open_review_room");
    expect(opener?._meta?.["openai/ui"]).toEqual({
      entrypoints: [{ type: "global" }, { type: "thread" }],
    });
    const opened = await client.callTool({
      name: "open_review_room",
      arguments: {},
    });
    expect(stateSchema.parse(opened.structuredContent).runs).toEqual([]);
    const store = new Store(join(dir, "state.sqlite"));
    const id = store.create(
      {
        repo: dir,
        base: "HEAD",
        checkpoint: "pagination",
        task: "test",
        rounds: 2,
        reviewers: [
          { name: "A", harness: "codex", model: "test" },
          { name: "B", harness: "claude", model: "test" },
        ],
      },
      "fingerprint",
    );
    for (let i = 0; i < 5; i++) store.message(id, "A", 1, `Message ${i}`);
    store.status(id, "completed");
    store.close();
    const state = await client.callTool({
      name: "review_room_state",
      arguments: {},
    });
    expect(
      stateSchema.parse(state.structuredContent).runs[0]?.messages,
    ).toEqual([]);
    const page = await client.callTool({
      name: "get_checkpoint_review",
      arguments: { id },
    });
    const messages = runSchema.parse(page.structuredContent).messages;
    expect(messages).toHaveLength(3);
    const next = await client.callTool({
      name: "get_checkpoint_review",
      arguments: { id, after: messages.at(-1)!.id },
    });
    expect(
      runSchema.parse(next.structuredContent).messages.map((m) => m.text),
    ).toEqual(["Message 3", "Message 4"]);
    const resource = await client.readResource({
      uri: "ui://review-room/panel",
    });
    expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(
      resource.contents[0] && "text" in resource.contents[0]
        ? resource.contents[0].text
        : "",
    ).toContain("Start checkpoint review");
    const html =
      resource.contents[0] && "text" in resource.contents[0]
        ? resource.contents[0].text
        : "";
    const script = html.match(
      /<script type="module">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(script).toBeDefined();
    expect(() =>
      new Bun.Transpiler({ loader: "js", target: "browser" }).transformSync(
        script!,
      ),
    ).not.toThrow();
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
