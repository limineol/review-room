import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { harnesses, type harnessSchema } from "./schema";

const candidates = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["opencode", "OpenCode"],
  ["gemini", "Gemini CLI"],
  ["cursor-agent", "Cursor Agent"],
  ["droid", "Factory Droid"],
  ["devin", "Devin"],
  ["grok", "Grok Build"],
  ["agy", "Antigravity"],
  ["forge", "ForgeCode"],
  ["hermes", "Hermes"],
  ["pi", "Pi"],
  ["omp", "Oh My Pi"],
  ["slate", "Slate"],
] as const;
export async function executable(name: string): Promise<string | undefined> {
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local/bin"),
    join(homedir(), ".bun/bin"),
    join(homedir(), ".opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const directory of directories.filter(Boolean)) {
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Continue searching PATH. */
    }
  }
}

export async function discover(): Promise<z.infer<typeof harnessSchema>[]> {
  const found = await Promise.all(
    candidates.map(async ([id, name]) => {
      const path = await executable(id);
      if (!path) return undefined;
      return {
        id,
        name: harnesses.some((h) => h === id)
          ? name
          : `${id} (possible ${name})`,
        path,
        runnable: harnesses.some((h) => h === id),
        models: [],
        modelSource:
          "Use the harness model catalog; account access is checked when run",
      };
    }),
  );
  return found.filter((value) => value !== undefined);
}
