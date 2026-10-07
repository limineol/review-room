import { expect, test } from "bun:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewProtocol } from "../src/review-protocol";
import { piGuardPath, openCodePermissions } from "../src/harness-policy";
import { checkReadOnlyTool } from "../src/pi-readonly";
import { parseOpenCodeModels } from "../src/model-catalog";
import { defaults, settingsSchema } from "../src/schema";
import type { Invocation } from "../src/harness";
const session = "b7a30851-4c2f-44e4-9f22-fbb13057936e";
function input(
  harness: "opencode" | "pi",
  sessionId: string | null = null,
): Invocation {
  return {
    reviewer: {
      name: "Reviewer",
      harness,
      model: "provider/model",
      sessionId,
      state: "idle",
    },
    repo: "/tmp/repository",
    prompt: "Inspect the code",
    schemaFile: "/tmp/review/schema.json",
    timeoutSeconds: 30,
    signal: new AbortController().signal,
    activity: () => {},
  };
}
test("new harnesses stay disabled when reading older saved settings", () => {
  const {
    opencodeEnabled: _oc,
    opencodeModels: _om,
    piEnabled: _pi,
    piModels: _pm,
    ...old
  } = defaults;
  const migrated = settingsSchema.parse({
    ...old,
    claudeEnabled: true,
    claudeModels: "opus",
  });
  expect(migrated.claudeModels).toBe("opus");
  expect(migrated.opencodeEnabled).toBe(false);
  expect(migrated.piEnabled).toBe(false);
});
test("OpenCode catalog strips provider options and omits models without tool support", () => {
  const item = (id: string, toolcall: boolean) =>
    `provider/${id}\n${JSON.stringify({ id, providerID: "provider", name: "Readable name", limit: { context: 128000 }, capabilities: { toolcall }, headers: { Authorization: "private" }, options: { private: "value" } }, null, 2)}\n`;
  const models = parseOpenCodeModels(
    item("model", true) + item("no-tools", false),
  );
  expect(models).toEqual([
    {
      id: "provider/model",
      name: "Readable name",
      description: "provider · 128,000 context tokens",
    },
  ]);
  expect(JSON.stringify(models)).not.toContain("private");
  expect(() => parseOpenCodeModels("provider/model\n{\n")).toThrow(
    "Incomplete",
  );
});
test("OpenCode reviews use explicit read-only permissions and resume the returned session", () => {
  const protocol = reviewProtocol(input("opencode", "ses_saved"));
  expect(protocol.args).toContain("--pure");
  expect(protocol.args.slice(-2)).toEqual(["--session", "ses_saved"]);
  expect(openCodePermissions["*"]).toBe("deny");
  expect(openCodePermissions.bash).toBe("deny");
  const seen: string[] = [];
  protocol.consume(
    {
      type: "text",
      sessionID: "ses_saved",
      part: { text: "Reading files first." },
    },
    () => {},
    (t) => seen.push(t),
  );
  protocol.consume(
    { type: "tool_use", part: { tool: "read" } },
    () => {},
    (t) => seen.push(t),
  );
  protocol.consume(
    {
      type: "text",
      part: {
        text: JSON.stringify({ body: "No verified defects", messages: [] }),
      },
    },
    () => {},
    (t) => seen.push(t),
  );
  expect(protocol.result()).toEqual({
    sessionId: "ses_saved",
    reply: { body: "No verified defects", messages: [] },
  });
  expect(seen).toEqual(["Using read to inspect code"]);
});
test("Pi sends no model prompt until its guard is verified, then continues the same session", () => {
  const protocol = reviewProtocol(input("pi", session));
  const commands: object[] = [];
  const write = (value: object) => commands.push(value);
  protocol.start(write);
  expect(commands).toEqual([{ id: "guard", type: "get_commands" }]);
  expect(() =>
    protocol.consume(
      {
        type: "response",
        id: "guard",
        command: "get_commands",
        success: true,
        data: { commands: [] },
      },
      write,
      () => {},
    ),
  ).toThrow("guard failed");
  expect(commands).toHaveLength(1);
  protocol.consume(
    {
      type: "response",
      id: "guard",
      command: "get_commands",
      success: true,
      data: {
        commands: [
          {
            name: "review-room-ready",
            source: "extension",
            sourceInfo: { path: piGuardPath },
          },
        ],
      },
    },
    write,
    () => {},
  );
  protocol.consume(
    {
      type: "response",
      id: "state",
      command: "get_state",
      success: true,
      data: { sessionId: session, messageCount: 2 },
    },
    write,
    () => {},
  );
  expect(commands[2]).toMatchObject({ type: "prompt" });
  protocol.consume(
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", text: "private" },
          { type: "text", text: '{"body":"Reviewed","messages":[]}' },
        ],
      },
    },
    write,
    () => {},
  );
  expect(protocol.consume({ type: "agent_settled" }, write, () => {})).toBe(
    true,
  );
  expect(protocol.result()).toEqual({
    sessionId: session,
    reply: { body: "Reviewed", messages: [] },
  });
  expect(protocol.args).toContain("--no-mcp");
  expect(protocol.args).toContain("--no-context-files");
});
test("Pi missing history is detected before a follow-up prompt is sent", () => {
  const protocol = reviewProtocol(input("pi", session));
  protocol.consume(
    {
      type: "response",
      id: "guard",
      command: "get_commands",
      success: true,
      data: {
        commands: [
          {
            name: "review-room-ready",
            source: "extension",
            sourceInfo: { path: piGuardPath },
          },
        ],
      },
    },
    () => {},
    () => {},
  );
  expect(() =>
    protocol.consume(
      {
        type: "response",
        id: "state",
        command: "get_state",
        success: true,
        data: { sessionId: session, messageCount: 0 },
      },
      () => {
        throw new Error("prompt sent");
      },
      () => {},
    ),
  ).toThrow("session not found");
});
test("Pi guard blocks writes, path escapes, and symlinks outside the repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-guard-"));
  const repo = join(dir, "repo");
  await Bun.write(join(repo, "source.ts"), "export const value = 1;");
  await writeFile(join(dir, "private.txt"), "outside");
  await symlink(join(dir, "private.txt"), join(repo, "link.txt"));
  try {
    expect(
      await checkReadOnlyTool(repo, {
        toolName: "read",
        input: { path: "source.ts" },
      }),
    ).toBeUndefined();
    for (const path of [
      "../private.txt",
      "link.txt",
      "~/private.txt",
      "file:///private.txt",
      "@source.ts",
    ])
      expect(
        (await checkReadOnlyTool(repo, { toolName: "read", input: { path } }))
          ?.block,
      ).toBe(true);
    expect(
      (
        await checkReadOnlyTool(repo, {
          toolName: "bash",
          input: { command: "touch source.ts" },
        })
      )?.block,
    ).toBe(true);
    expect(
      await checkReadOnlyTool(repo, {
        toolName: "grep",
        input: { pattern: "value" },
      }),
    ).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode rejects permissive merged policies before a model turn", async () => {
  const { verifyOpenCodePermissions } =
    await import("../src/opencode-preflight");
  const deny = { permission: "*", pattern: "*", action: "deny" };
  expect(() =>
    verifyOpenCodePermissions({
      permission: [
        { permission: "webfetch", pattern: "*", action: "allow" },
        deny,
        { permission: "read", pattern: "*", action: "allow" },
      ],
    }),
  ).not.toThrow();
  for (const permission of [
    "webfetch",
    "custom_mcp_tool",
    "external_directory",
    "bash",
  ])
    expect(() =>
      verifyOpenCodePermissions({
        permission: [deny, { permission, pattern: "*", action: "allow" }],
      }),
    ).toThrow("extra tools");
});
test("OpenCode errors identify expired authentication and missing sessions", () => {
  const protocol = reviewProtocol(input("opencode", "ses_saved"));
  expect(() =>
    protocol.consume(
      {
        type: "error",
        error: {
          name: "UnknownError",
          data: { message: "Token refresh failed: 401" },
        },
      },
      () => {},
      () => {},
    ),
  ).toThrow("opencode auth login");
  expect(() =>
    protocol.consume(
      {
        type: "error",
        error: {
          name: "NotFoundError",
          data: { message: "Session does not exist" },
        },
      },
      () => {},
      () => {},
    ),
  ).toThrow("session not found");
});
test("provider-qualified model IDs support Vertex version separators", async () => {
  const { modelSchema } = await import("../src/schema");
  expect(
    modelSchema.parse("google-vertex-anthropic/claude-sonnet-4@20250514"),
  ).toBe("google-vertex-anthropic/claude-sonnet-4@20250514");
});

test("a settled Pi result survives a process that does not exit on stdin close", async () => {
  const { invoke } = await import("../src/harness");
  const dir = await mkdtemp(join(tmpdir(), "pi-settled-"));
  const previous = process.env.PATH;
  await writeFile(
    join(dir, "pi"),
    `#!${process.execPath}\nlet buffer="";setInterval(()=>{},1000);process.stdin.on("data",chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf("\\n"))>=0){const cmd=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(cmd.type==="get_commands") console.log(JSON.stringify({type:"response",command:cmd.type,id:cmd.id,success:true,data:{commands:[{name:"review-room-ready",source:"extension",sourceInfo:{path:process.argv[process.argv.indexOf("--extension")+1]}}]}}));if(cmd.type==="get_state") console.log(JSON.stringify({type:"response",command:cmd.type,id:cmd.id,success:true,data:{sessionId:"${session}",messageCount:0}}));if(cmd.type==="prompt"){console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:'{"body":"Complete","messages":[]}'}]}}));console.log(JSON.stringify({type:"agent_settled"}));}}});`,
    { mode: 0o755 },
  );
  try {
    process.env.PATH = `${dir}:${previous ?? ""}`;
    const result = await invoke({
      ...input("pi"),
      repo: dir,
      schemaFile: join(dir, "schema.json"),
      timeoutSeconds: 1,
    });
    expect(result.reply.body).toBe("Complete");
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("reviewer diagnostics remove credentials from provider errors and terminal output", async () => {
  const { redactDiagnostic } = await import("../src/review-protocol");
  const tokens = [
    "sk-" + "a".repeat(40),
    "AIza" + "x".repeat(35),
    "AKIA" + "B".repeat(16),
  ];
  const result = redactDiagnostic(
    `\u001b[31mError: ${tokens.join(" ")} x-api-key: short-secret email@example.com https://example.com/?token=private\u001b[0m`,
  );
  for (const token of [
    ...tokens,
    "short-secret",
    "email@example.com",
    "?token=private",
    "\u001b",
  ])
    expect(result).not.toContain(token);
  expect(result.startsWith("Error:")).toBe(true);
});
