import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import type { harnessSchema } from "./schema";

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
const cacheSchema = z.object({
  models: z.array(z.object({ slug: z.string() })),
});

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
  let codexModels: string[] = [];
  try {
    const cache = cacheSchema.parse(
      JSON.parse(
        await readFile(
          join(
            process.env.CODEX_HOME ?? join(homedir(), ".codex"),
            "models_cache.json",
          ),
          "utf8",
        ),
      ),
    );
    codexModels = cache.models.map((model) => model.slug);
  } catch {
    /* A CLI need not have a model cache yet. */
  }
  const found = await Promise.all(
    candidates.map(async ([id, name]) => {
      const path = await executable(id);
      if (!path) return undefined;
      return {
        id,
        name:
          id === "codex" || id === "claude" ? name : `${id} (possible ${name})`,
        path,
        runnable: id === "codex" || id === "claude",
        models:
          id === "codex"
            ? codexModels
            : id === "claude"
              ? ["opus", "sonnet", "fable"]
              : [],
        modelSource:
          id === "codex"
            ? "Local model cache; availability is checked when run"
            : id === "claude"
              ? "CLI aliases; enter an exact model ID if preferred"
              : "Discovery only; execution adapter not yet supported",
      };
    }),
  );
  return found.filter((value) => value !== undefined);
}
