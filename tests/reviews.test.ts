import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Reviews } from "../src/runner";
import type { Start } from "../src/schema";
import {
  MissingSessionError,
  type Invoke,
  type Invocation,
} from "../src/harness";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function setup(call: Invoke) {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "review-room-test-")),
  );
  const store = new Store(join(dir, "state.sqlite"));
  store.updateSettings({
    codexEnabled: true,
    codexModels: "test",
    claudeEnabled: true,
    claudeModels: "test",
  });
  const reviews = new Reviews(store, call, dir);
  cleanup.push(async () => {
    reviews.shutdown();
    await Bun.sleep(30);
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store, reviews };
}
const config = (repo: string): Start => ({
  repo,
  label: "Current changes",
  prompt: "Inspect code and report defects",
  reviewers: [
    { name: "A", harness: "codex", model: "test" },
    { name: "B", harness: "claude", model: "test" },
  ],
});
async function ready(store: Store, id: string) {
  for (let i = 0; i < 100; i++) {
    const run = store.get(id);
    if (run.status !== "running") return run;
    await Bun.sleep(20);
  }
  throw new Error("Review did not settle");
}

test("reviewers inspect live files, peer questions are routed, and agent decides when to collect", async () => {
  const seen: Invocation[] = [];
  const { dir, store, reviews } = await setup(async (input) => {
    seen.push(input);
    const content = await readFile(join(input.repo, "code.ts"), "utf8");
    return {
      sessionId: input.reviewer.sessionId ?? crypto.randomUUID(),
      reply: {
        body: `Read code.ts: ${content}`,
        messages:
          input.reviewer.name === "A" && !input.reviewer.sessionId
            ? [{ to: "B", text: "Please verify the empty input contract" }]
            : [],
      },
    };
  });
  await writeFile(join(dir, "code.ts"), "empty input returns NaN");
  const run = await reviews.start(config(dir));
  const done = await ready(store, run.id);
  expect(done.status).toBe("ready");
  expect(seen).toHaveLength(4);
  expect(
    done.messages.some((m) => m.sender === "B" && m.recipient === "A"),
  ).toBe(true);
  expect(seen.filter((x) => x.reviewer.name === "B")[1]?.prompt).toContain(
    "Message from A",
  );
  expect(done.messages.some((m) => m.text.includes("NaN"))).toBe(true);
  const b = seen.filter((x) => x.reviewer.name === "B");
  expect(b[0]?.reviewer.sessionId).toBeNull();
  expect(b[1]?.reviewer.sessionId).toBeTruthy();
  const artifact = await reviews.collect(run.id);
  expect(store.get(run.id).status).toBe("completed");
  expect(await readFile(artifact.artifact!, "utf8")).toContain("Please verify");
});
test("agent follow-ups resume within a cycle; cross-cycle reuse defaults off and stays room-scoped", async () => {
  const seen: Invocation[] = [];
  const { dir, store, reviews } = await setup(async (input) => {
    seen.push(input);
    return {
      sessionId: input.reviewer.sessionId ?? crypto.randomUUID(),
      reply: { body: "No verified defects.", messages: [] },
    };
  });
  const first = await reviews.start({
    ...config(dir),
    reviewers: [config(dir).reviewers[0]!],
  });
  await ready(store, first.id);
  const session = store.get(first.id).reviewers[0]!.sessionId;
  reviews.send(first.id, "A", "Check again");
  await ready(store, first.id);
  expect(seen[1]?.reviewer.sessionId).toBe(session);
  await reviews.collect(first.id);
  const second = await reviews.start({
    ...config(dir),
    reviewers: [config(dir).reviewers[0]!],
    roomId: first.roomId,
  });
  await ready(store, second.id);
  expect(seen[2]?.reviewer.sessionId).toBeNull();
  await reviews.collect(second.id);
  const nextSession = store.get(second.id).reviewers[0]!.sessionId;
  store.updateSettings({ reuseSessions: true });
  const third = await reviews.start({
    ...config(dir),
    reviewers: [config(dir).reviewers[0]!],
    roomId: first.roomId,
  });
  await ready(store, third.id);
  expect(seen[3]?.reviewer.sessionId).toBe(nextSession);
  await reviews.collect(third.id);
  const separate = await reviews.start({
    ...config(dir),
    reviewers: [config(dir).reviewers[0]!],
  });
  await ready(store, separate.id);
  expect(seen[4]?.reviewer.sessionId).toBeNull();
});
test("disabled models are rejected and malformed settings do not replace valid settings", async () => {
  const { dir, store, reviews } = await setup(async () => {
    throw new Error("must not run");
  });
  store.updateSettings({ codexEnabled: false });
  await expect(reviews.start(config(dir))).rejects.toThrow("not enabled");
  expect(() => store.updateSettings({ claudeModels: "bad;model" })).toThrow();
  expect(store.settings().claudeModels).toBe("test");
});
test("wait ignores activity and returns published messages with a cursor; cancellation stops active reviewers", async () => {
  let aborted = 0;
  const { dir, store, reviews } = await setup(async ({ signal, activity }) => {
    activity("Reading file");
    return await new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => {
        aborted++;
        reject(new Error("cancelled"));
      }),
    );
  });
  const run = await reviews.start(config(dir));
  await Bun.sleep(20);
  const first = await reviews.wait(run.id, 0, 0);
  expect(first.messages.every((m) => m.kind !== "activity")).toBe(true);
  const waiting = reviews.wait(run.id, first.cursor, 5);
  reviews.stop(run.id);
  expect((await waiting).run.status).toBe("cancelled");
  await Bun.sleep(20);
  expect(aborted).toBe(2);
  expect(store.get(run.id).status).toBe("cancelled");
  expect(store.get(run.id).reviewers.every((r) => r.state === "stopped")).toBe(
    true,
  );
});
test("turn budget stops peer ping-pong without silently accepting more agent work", async () => {
  let calls = 0;
  const { dir, store, reviews } = await setup(async ({ reviewer }) => {
    calls++;
    return {
      sessionId: crypto.randomUUID(),
      reply: {
        body: "Question",
        messages: [
          { to: reviewer.name === "A" ? "B" : "A", text: "Another question" },
        ],
      },
    };
  });
  store.updateSettings({ maxTurns: 4 });
  const run = await reviews.start(config(dir));
  const done = await ready(store, run.id);
  expect(calls).toBe(4);
  expect(done.status).toBe("ready");
  expect(done.messages.some((m) => m.text.includes("not queued"))).toBe(true);
  expect(() => reviews.send(run.id, "all", "Continue")).toThrow("Turn limit");
});
test("failure is visible and collect refuses to present a failed cycle as complete", async () => {
  const { dir, store, reviews } = await setup(async () => {
    throw new Error("Model access denied");
  });
  const run = await reviews.start(config(dir));
  const done = await ready(store, run.id);
  expect(done.status).toBe("failed");
  expect(
    done.messages.some((m) => m.text.includes("Model access denied")),
  ).toBe(true);
  const collected = await reviews.collect(run.id);
  expect(collected.run.status).toBe("failed");
  expect(await readFile(collected.artifact!, "utf8")).toContain(
    "Model access denied",
  );
});

test("ready findings survive owner shutdown and a replacement worker can continue and collect", async () => {
  const call: Invoke = async (input) => ({
    sessionId: input.reviewer.sessionId ?? crypto.randomUUID(),
    reply: { body: "Verified finding", messages: [] },
  });
  const { dir, store, reviews } = await setup(call);
  const run = await reviews.start(config(dir));
  await ready(store, run.id);
  reviews.shutdown();
  expect(store.get(run.id).status).toBe("ready");
  const replacement = new Reviews(store, call, dir);
  try {
    replacement.send(run.id, "A", "Recheck");
    await ready(store, run.id);
    const collected = await replacement.collect(run.id);
    expect(collected.run.status).toBe("completed");
    expect(await readFile(collected.artifact!, "utf8")).toContain(
      "Verified finding",
    );
  } finally {
    replacement.shutdown();
  }
});

test("one reviewer failure preserves other findings and produces a partial artifact", async () => {
  const { dir, store, reviews } = await setup(async (input) => {
    if (input.reviewer.name === "B") throw new Error("Provider rate limit");
    await Bun.sleep(30);
    return {
      sessionId: crypto.randomUUID(),
      reply: { body: "A verified the defect.", messages: [] },
    };
  });
  const run = await reviews.start(config(dir));
  const done = await ready(store, run.id);
  expect(done.status).toBe("ready");
  expect(done.reviewers.find((r) => r.name === "A")?.state).toBe("idle");
  reviews.send(run.id, "all", "Please confirm the available findings");
  await ready(store, run.id);
  expect(() => reviews.send(run.id, "B", "Retry")).toThrow("failed");
  const collected = await reviews.collect(run.id);
  expect(collected.run.status).toBe("partial");
  const text = await readFile(collected.artifact!, "utf8");
  expect(text).toContain("A verified the defect");
  expect(text).toContain("Provider rate limit");
});

test("missing reused sessions recover once and are not selected repeatedly after failed recovery", async () => {
  let mode: "complete" | "missing" | "fresh-failure" = "complete";
  const seen: Array<string | null> = [];
  const { dir, store, reviews } = await setup(async (input) => {
    seen.push(input.reviewer.sessionId);
    if (mode !== "complete" && input.reviewer.sessionId)
      throw new MissingSessionError("No conversation found");
    if (mode === "fresh-failure") throw new Error("Provider unavailable");
    return {
      sessionId: input.reviewer.sessionId ?? crypto.randomUUID(),
      reply: { body: "Reviewed", messages: [] },
    };
  });
  const selection = { ...config(dir), reviewers: [config(dir).reviewers[0]!] };
  const first = await reviews.start(selection);
  await ready(store, first.id);
  await reviews.collect(first.id);
  store.updateSettings({ reuseSessions: true });
  mode = "fresh-failure";
  const second = await reviews.start({ ...selection, roomId: first.roomId });
  await ready(store, second.id);
  expect(store.get(second.id).status).toBe("failed");
  expect(seen.slice(-2)[0]).toBeTruthy();
  expect(seen.at(-1)).toBeNull();
  mode = "complete";
  const third = await reviews.start({ ...selection, roomId: first.roomId });
  await ready(store, third.id);
  expect(seen.at(-1)).toBeNull();
  await reviews.collect(third.id);
  mode = "missing";
  const fourth = await reviews.start({ ...selection, roomId: first.roomId });
  await ready(store, fourth.id);
  expect(seen.slice(-2)[0]).toBeTruthy();
  expect(seen.at(-1)).toBeNull();
  expect((await reviews.collect(fourth.id)).run.status).toBe("completed");
});

test("an expired wall-clock heartbeat does not interrupt a live owner after sleep", async () => {
  const { Database } = await import("bun:sqlite");
  const { dir, store, reviews } = await setup(
    async (input) =>
      await new Promise((_resolve, reject) =>
        input.signal.addEventListener("abort", () =>
          reject(new Error("cancelled")),
        ),
      ),
  );
  const run = await reviews.start(config(dir));
  await Bun.sleep(20);
  const db = new Database(join(dir, "state.sqlite"));
  db.query("UPDATE cycles SET heartbeat=0 WHERE id=?").run(run.id);
  db.close();
  expect(store.get(run.id).status).toBe("running");
  reviews.stop(run.id);
});

test("agent pages omit prompt echoes and bound findings without skipping later messages", async () => {
  const { dir, store, reviews } = await setup(async () => ({
    sessionId: crypto.randomUUID(),
    reply: { body: "x".repeat(20000), messages: [] },
  }));
  const run = await reviews.start(config(dir));
  await ready(store, run.id);
  const first = await reviews.wait(run.id, 0, 0);
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]?.sender).not.toBe("agent");
  expect(first.hasMore).toBe(true);
  expect("prompt" in first.run).toBe(false);
  const next = await reviews.wait(run.id, first.cursor, 0);
  expect(next.messages).toHaveLength(1);
  expect(next.hasMore).toBe(false);
});

test("all remains a valid recipient when there is only one reviewer", async () => {
  const { dir, store, reviews } = await setup(async () => ({
    sessionId: crypto.randomUUID(),
    reply: {
      body: "Reviewed",
      messages: [
        { to: "all", text: "Does the contract include negative values?" },
      ],
    },
  }));
  const run = await reviews.start({
    ...config(dir),
    reviewers: [config(dir).reviewers[0]!],
  });
  const done = await ready(store, run.id);
  expect(done.messages.some((m) => m.text.includes("unknown recipient"))).toBe(
    false,
  );
  expect(
    done.messages.some((m) => m.recipient === "all" && m.sender === "A"),
  ).toBe(true);
});
