import { z } from "zod";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const versionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
const { version } = versionSchema.parse(
  JSON.parse(await readFile("plugin.json", "utf8")),
);
for (const file of ["package.json", ".codex-plugin/plugin.json"]) {
  if (
    versionSchema.parse(JSON.parse(await readFile(file, "utf8"))).version !==
    version
  )
    throw new Error(`Version mismatch in ${file}`);
}
const output = resolve(
  process.argv[2] ?? join(tmpdir(), "review-room-release"),
);
const temporary = await mkdtemp(join(tmpdir(), "review-room-package-"));
const root = join(temporary, "review-room");
try {
  await mkdir(root);
  await mkdir(output, { recursive: true });
  for (const path of [
    "plugin.json",
    ".codex-plugin",
    "mcp.json",
    ".mcp.json",
    "skills",
    "assets",
    "README.md",
    "LICENSE",
  ])
    await cp(path, join(root, path), { recursive: true });
  await mkdir(join(root, "dist"));
  for (const path of [
    "THIRD_PARTY_NOTICES.txt",
    "server.js",
    "panel.html",
    "model-picker.html",
    "pi-readonly.js",
  ])
    await cp(join("dist", path), join(root, "dist", path));
  const archive = join(output, `review-room-${version}.zip`);
  await rm(archive, { force: true });
  const zipped = Bun.spawn(["zip", "-qr", archive, "review-room"], {
    cwd: temporary,
    stdout: "ignore",
    stderr: "inherit",
  });
  if (await zipped.exited) throw new Error("Plugin archive creation failed.");
  console.log(archive);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
