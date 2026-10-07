import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { openCodeEnvironment, openCodePermissions } from "./harness-policy";
const execute = promisify(execFile);
const ruleSchema = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(["allow", "ask", "deny"]),
});
const agentSchema = z.object({ permission: z.array(ruleSchema) });
export function verifyOpenCodePermissions(value: unknown) {
  const rules = agentSchema.parse(value).permission;
  const lastDeny = rules.findLastIndex(
    (r) => r.permission === "*" && r.pattern === "*" && r.action === "deny",
  );
  if (
    lastDeny < 0 ||
    rules
      .slice(lastDeny + 1)
      .some(
        (r) =>
          r.action !== "deny" &&
          !["read", "grep", "glob", "list"].includes(r.permission),
      )
  )
    throw new Error(
      "OpenCode configuration grants extra tools or external paths. Review was not started.",
    );
}
export async function prepareOpenCode(
  command: string,
  repo: string,
  signal: AbortSignal,
  deadline = Date.now() + 30000,
) {
  const base = { ...process.env, ...openCodeEnvironment };
  async function inspect(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    try {
      const output = await execute(command, [...args, "--pure"], {
        cwd: repo,
        env,
        signal,
        timeout: Math.max(1, Math.min(10000, deadline - Date.now())),
        killSignal: "SIGKILL",
        maxBuffer: 2_000_000,
      });
      return output.stdout;
    } catch {
      if (signal.aborted) throw new Error("Review cancelled");
      if (Date.now() >= deadline)
        throw new Error("Reviewer time limit exceeded");
      throw new Error(
        "Could not verify OpenCode configuration before the review. Check its installation and configuration.",
      );
    }
  }
  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      if (signal.aborted) throw new Error("Review cancelled");
      if (Date.now() >= deadline)
        throw new Error("Reviewer time limit exceeded");
      throw new Error("OpenCode returned invalid configuration data.");
    }
  };
  const data = (await inspect(["debug", "paths"], base))
    .match(/^data\s+(.+)$/m)?.[1]
    ?.trim();
  if (!data || !isAbsolute(data))
    throw new Error("OpenCode did not report its data directory.");
  const config = z
    .object({ mcp: z.record(z.string(), z.unknown()).optional() })
    .parse(json(await inspect(["debug", "config"], base)));
  const permissions = {
    ...openCodePermissions,
    external_directory: {
      "*": "deny",
      [join(data, "tool-output", "*")]: "deny",
    },
  };
  const env = {
    ...openCodeEnvironment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      share: "disabled",
      autoshare: false,
      lsp: false,
      permission: permissions,
      mcp: Object.fromEntries(
        Object.keys(config.mcp ?? {}).map((name) => [name, { enabled: false }]),
      ),
      agent: {
        "review-room": {
          mode: "primary",
          description: "Read-only repository reviewer",
          permission: permissions,
        },
      },
    }),
  };
  verifyOpenCodePermissions(
    json(
      await inspect(["debug", "agent", "review-room"], {
        ...process.env,
        ...env,
      }),
    ),
  );
  return env;
}
