import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateSchema } from "../src/schema";

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
    const resource = await client.readResource({
      uri: "ui://review-room/panel",
    });
    expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(
      resource.contents[0] && "text" in resource.contents[0]
        ? resource.contents[0].text
        : "",
    ).toContain("Start checkpoint review");
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
