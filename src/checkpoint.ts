import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const limit = 300_000;

export async function checkpoint(repo: string, base: string) {
  if (!isAbsolute(repo)) throw new Error("Choose an absolute repository path.");
  const root = await realpath(repo);
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-C", root, ...args], {
        maxBuffer: limit * 2,
        timeout: 15_000,
      })
    ).stdout;
  const top = (await git("rev-parse", "--show-toplevel")).trim();
  if ((await realpath(top)) !== root)
    throw new Error("Choose the repository root.");
  const revision = (
    await git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`)
  ).trim();
  let text = await git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    revision,
    "--",
  );
  const untracked = (
    await git("ls-files", "--others", "--exclude-standard", "-z")
  )
    .split("\0")
    .filter(Boolean);
  for (const file of untracked) {
    const path = join(root, file);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > limit)
      throw new Error(
        `Cannot capture ${file}: not a regular file or exceeds checkpoint limit.`,
      );
    const content = await readFile(path);
    if (content.includes(0))
      throw new Error(`Cannot review binary untracked file: ${file}`);
    text += `\n--- Untracked file: ${JSON.stringify(file)} ---\n${content.toString("utf8")}\n`;
    if (Buffer.byteLength(text) > limit)
      throw new Error("Checkpoint exceeds 300 KB. Choose a smaller change.");
  }
  if (Buffer.byteLength(text) > limit)
    throw new Error("Checkpoint exceeds 300 KB. Choose a smaller change.");
  if (!text.trim())
    throw new Error("No changes relative to the selected base.");
  return {
    text,
    repo: root,
    revision,
    fingerprint: createHash("sha256").update(text).digest("hex"),
  };
}
