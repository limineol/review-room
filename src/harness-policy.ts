import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Invocation } from "./harness";

export const piIsolation = [
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
  "--offline",
];
export const openCodePermissions = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  edit: "deny",
  bash: "deny",
  task: "deny",
  external_directory: "deny",
  webfetch: "deny",
  websearch: "deny",
  codesearch: "deny",
  skill: "deny",
  todowrite: "deny",
  todoread: "deny",
  lsp: "deny",
  question: "deny",
};
export const openCodeEnvironment = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_PRUNE: "1",
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  OPENCODE_PURE: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    share: "disabled",
    autoshare: false,
    lsp: false,
    permission: openCodePermissions,
    agent: {
      "review-room": {
        mode: "primary",
        description: "Read-only repository reviewer",
        permission: openCodePermissions,
      },
    },
  }),
};
export const piGuardPath = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./pi-readonly.ts" : "./pi-readonly.js",
    import.meta.url,
  ),
);
export function piSessionDirectory(input: Invocation) {
  const repoHash = createHash("sha256")
    .update(input.repo)
    .digest("hex")
    .slice(0, 16);
  return join(dirname(input.schemaFile), "pi-sessions", repoHash);
}
