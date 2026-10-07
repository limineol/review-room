import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
const packageSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.union([z.string(), z.object({ type: z.string() })]).optional(),
});
export async function writeNotices(metafiles: Bun.BuildMetafile[]) {
  const packages = new Set<string>();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const normalized = input.replaceAll("\\", "/");
      const at = normalized.lastIndexOf("node_modules/");
      if (at < 0) continue;
      const parts = normalized.slice(at + 13).split("/");
      packages.add(parts.slice(0, parts[0]?.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  const notices: string[] = [
    "Third-party notices for the bundled Review Room runtime.",
  ];
  const missing: string[] = [];
  for (const name of [...packages].sort()) {
    const directory = join("node_modules", name);
    const info = packageSchema.parse(
      JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    );
    const files = (await readdir(directory))
      .filter((file) => /^(licen[sc]e|notice|copying)(?:\.|$)/i.test(file))
      .sort();

    const license =
      typeof info.license === "string" ? info.license : info.license?.type;
    notices.push(
      `\n${info.name}@${info.version}${license ? ` (${license})` : ""}\n${"=".repeat(72)}`,
    );
    if (!files.length) {
      try {
        notices.push(
          (
            await readFile(
              join(
                "third-party",
                name.replace(/^@/, "").replaceAll("/", "-") + ".LICENSE",
              ),
              "utf8",
            )
          ).trim(),
        );
      } catch {
        missing.push(name);
      }
    }
    for (const file of files)
      notices.push(
        (await readFile(join(directory, file), "utf8"))
          .replaceAll("\r\n", "\n")
          .trim(),
      );
  }
  if (missing.length)
    throw new Error(`Missing license notices: ${missing.join(", ")}`);
  await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n\n") + "\n");
}
