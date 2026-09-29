import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { settingsSchema } from "../src/schema";
test("native settings, agent tools, and observational panel are discoverable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-room-mcp-"));
  const client = new Client({ name: "test", version: "1" });
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/server.js"],
        env: {
          ...env,
          REVIEW_ROOM_DB: join(dir, "state.sqlite"),
          REVIEW_ROOM_DATA: dir,
        },
        stderr: "pipe",
      }),
    );
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toContain("review_wait");
    expect(tools.map((t) => t.name)).not.toContain("start_checkpoint_review");
    expect(
      tools.find((t) => t.name === "open_review_room")?._meta?.["openai/ui"],
    ).toEqual({ entrypoints: [{ type: "global" }, { type: "thread" }] });
    const settings = await client.callTool({
      name: "settings.read",
      arguments: {},
    });
    const read = z
      .object({ values: settingsSchema })
      .parse(settings.structuredContent);
    expect(read.values.reuseSessions).toBe(false);
    await client.callTool({
      name: "settings.update",
      arguments: { set: { claudeEnabled: true, claudeModels: "opus" } },
    });
    const next = z
      .object({ values: settingsSchema })
      .parse(
        (await client.callTool({ name: "settings.read", arguments: {} }))
          .structuredContent,
      );
    expect(next.values.claudeModels).toBe("opus");
    expect(next.values.reuseSessions).toBe(false);
    const resource = await client.readResource({
      uri: "ui://review-room/panel-v2",
    });
    const first = resource.contents[0];
    const html = first && "text" in first ? first.text : "";
    expect(html).toContain("Request review");
    expect(html).not.toContain('id="repo"');
    expect(html).not.toContain('id="rounds"');
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
