import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkpoint } from "../src/checkpoint";
import { Store } from "../src/store";
import { Reviews } from "../src/runner";
import type { Start } from "../src/schema";

const dirs: string[] = [];
afterEach(async () => {
  for (const path of dirs.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function repository() {
  const path = await mkdtemp(join(tmpdir(), "review-room-test-"));
  dirs.push(path);
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args]);
  git("init", "-q");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  await writeFile(join(path, "change.ts"), "export const value = 1;\n");
  return { path, git };
}
const config = (repo: string): Start => ({
  repo,
  base: "HEAD",
  checkpoint: "test",
  task: "Review the change",
  rounds: 2,
  reviewers: [
    { name: "A", harness: "codex", model: "test-model" },
    { name: "B", harness: "claude", model: "test-model" },
  ],
});
async function finished(store: Store, id: string) {
  for (let i = 0; i < 100; i++) {
    const run = store.get(id);
    if (run.status !== "running") return run;
    await Bun.sleep(10);
  }
  throw new Error("Run did not finish");
}
test("captures tracked and untracked changes without executing diff drivers", async () => {
  const { path, git } = await repository();
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "baseline",
  );
  await writeFile(join(path, "change.ts"), "export const value = 2;\n");
  await writeFile(join(path, "new.ts"), "export const next = 3;\n");
  const snapshot = await checkpoint(path, "HEAD");
  expect(snapshot.text).toContain("+export const value = 2");
  expect(snapshot.text).toContain("export const next = 3");
  expect(snapshot.fingerprint).toHaveLength(64);
  expect(await checkpoint(path, "HEAD")).toEqual(snapshot);
});
test("rejects symlinks and oversized snapshots instead of silently omitting code", async () => {
  const { path } = await repository();
  await symlink("/etc/hosts", join(path, "external"));
  await expect(checkpoint(path, "HEAD")).rejects.toThrow("not a regular file");
  await rm(join(path, "external"));
  await writeFile(join(path, "large.txt"), "a".repeat(300_001));
  await expect(checkpoint(path, "HEAD")).rejects.toThrow(
    "exceeds checkpoint limit",
  );
});
test("independent first round, shared later round, and frozen diff", async () => {
  const { path } = await repository();
  const store = new Store(":memory:");
  const prompts: string[] = [];
  const reviews = new Reviews(store, async (reviewer, prompt) => {
    prompts.push(prompt);
    await writeFile(join(path, "change.ts"), "MUTATED AFTER CAPTURE");
    return `Finding from ${reviewer.name}`;
  });
  const started = await reviews.start(config(path));
  const done = await finished(store, started.id);
  expect(done.status).toBe("completed");
  expect(prompts).toHaveLength(4);
  expect(prompts[1]).not.toContain("Finding from A");
  expect(prompts[2]).toContain("Finding from A");
  expect(prompts[2]).toContain("Finding from B");
  expect(prompts.every((p) => !p.includes("MUTATED AFTER CAPTURE"))).toBe(true);
  expect(done.messages.filter((m) => m.round > 0)).toHaveLength(4);
  expect(store.list()[0]?.messages).toEqual([]);
  store.close();
});
test("cancellation aborts the active reviewer and prevents subsequent turns", async () => {
  const { path } = await repository();
  const store = new Store(":memory:");
  let calls = 0;
  let aborted = false;
  const reviews = new Reviews(store, async (_reviewer, _prompt, signal) => {
    calls++;
    return await new Promise<string>((_resolve, reject) =>
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }),
    );
  });
  const started = await reviews.start(config(path));
  reviews.stop(started.id);
  await Bun.sleep(30);
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
  expect(store.get(started.id).status).toBe("cancelled");
  store.close();
});
test("reviewer errors become a visible failed run", async () => {
  const { path } = await repository();
  const store = new Store(":memory:");
  const reviews = new Reviews(store, async () => {
    throw new Error("Model access denied");
  });
  const started = await reviews.start(config(path));
  const done = await finished(store, started.id);
  expect(done.status).toBe("failed");
  expect(done.messages.at(-1)?.text).toContain("Model access denied");
  store.close();
});

test("expired heartbeat interrupts a run even when its owner PID still exists", async () => {
  const { Database } = await import("bun:sqlite");
  const { path } = await repository();
  const dbPath = join(path, "state.sqlite");
  const store = new Store(dbPath);
  const id = store.create(config(path), "test");
  const db = new Database(dbPath);
  db.query("UPDATE leases SET heartbeat=0 WHERE run=?").run(id);
  db.close();
  expect(store.get(id).status).toBe("interrupted");
  store.status(id, "completed");
  expect(store.get(id).status).toBe("interrupted");
  store.close();
});
