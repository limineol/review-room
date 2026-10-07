import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { nativeSettingsSchema as settingsSchema } from "../src/model-settings";
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
    expect(
      client.getServerCapabilities()?.experimental?.["openai/settings"],
    ).toEqual({ readTool: "settings.read", updateTool: "settings.update" });
    const packageInfo = z
      .object({ version: z.string() })
      .parse(await Bun.file("package.json").json());
    expect(client.getServerVersion()?.version).toBe(packageInfo.version);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toContain("choose_opencode_models");
    expect(tools.map((t) => t.name)).toContain("choose_pi_models");
    expect(tools.map((t) => t.name)).toContain("review_wait");
    expect(tools.map((t) => t.name)).toContain("review_set_thread_title");
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
    expect(read.values.opencodeEnabled).toBe(false);
    expect(read.values.piEnabled).toBe(false);
    await client.callTool({
      name: "settings.update",
      arguments: { set: { claudeEnabled: true } },
    });
    const next = z
      .object({ values: settingsSchema })
      .parse(
        (await client.callTool({ name: "settings.read", arguments: {} }))
          .structuredContent,
      );
    expect(next.values.claudeEnabled).toBe(true);
    expect(Object.keys(next.values)).not.toContain("claudeModels");
    expect(tools.map((t) => t.name)).toContain("choose_claude_models");
    const picker = await client.readResource({
      uri: "ui://review-room/model-picker",
    });
    expect(picker.contents[0]).toHaveProperty("text");
    expect(next.values.reuseSessions).toBe(false);
    const resource = await client.readResource({
      uri: "ui://review-room/panel-v2",
    });
    const first = resource.contents[0];
    const html = first && "text" in first ? first.text : "";
    expect(html).not.toContain("Request review");
    expect(html).not.toContain('id="history"');
    expect(html).toContain('id="cards"');
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
