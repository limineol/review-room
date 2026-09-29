import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  readFile,
  rm,
} from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

test("modern MCP discovery, filtered push delivery, artifact, and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-events-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "claude"),
    `#!${process.execPath}\nsetTimeout(()=>console.log('# Review\\nTest reviewer output.'),100);`,
  );
  await chmod(join(bin, "claude"), 0o700);
  const client = new Client(
    { name: "test", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const incoming = z.object({
    eventId: z.string(),
    data: z.object({
      runId: z.string(),
      status: z.string(),
      artifact: z.string(),
    }),
    _meta: z.record(z.string(), z.unknown()),
  });
  let resolveEvent: (value: z.infer<typeof incoming>) => void = () => {};
  const delivered = new Promise<z.infer<typeof incoming>>((resolve) => {
    resolveEvent = resolve;
  });
  const received: z.infer<typeof incoming>[] = [];
  client.setNotificationHandler(
    "notifications/events/event",
    { params: incoming },
    (event) => {
      received.push(event);
      resolveEvent(event);
    },
  );
  const stop = new AbortController();
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, "../../dist/events-probe.js")],
        env: {
          ...env,
          PATH: bin + delimiter + env.PATH,
          REVIEW_ROOM_PROBE_OUTPUT: root,
        },
        stderr: "pipe",
      }),
    );
    expect(client.getDiscoverResult()?.supportedVersions).toContain(
      "2026-07-28",
    );
    const catalog = await client.request(
      { method: "events/list", params: {} },
      z.object({
        events: z.array(
          z.object({ name: z.string(), delivery: z.array(z.string()) }),
        ),
      }),
    );
    expect(catalog.events[0]).toEqual({
      name: "review.completed",
      delivery: ["push"],
    });
    const result = await client.callTool({
      name: "probe_start_review",
      arguments: { repo: root, prompt: "Test" },
    });
    const content = result.content.find((c) => c.type === "text");
    if (!content || content.type !== "text") throw new Error("No response");
    const { runId } = z
      .object({ runId: z.string() })
      .parse(JSON.parse(content.text));
    const stream = (id: string) =>
      client
        .request(
          {
            method: "events/stream",
            params: {
              name: "review.completed",
              arguments: { runId: id },
              cursor: null,
            },
          },
          z.object({}),
          { signal: stop.signal, timeout: 5000 },
        )
        .catch(() => {});
    const streams = [stream(runId), stream(crypto.randomUUID())];
    const event = await delivered;
    expect(event.data.runId).toBe(runId);
    expect(event.data.status).toBe("completed");
    expect(event._meta["io.modelcontextprotocol/subscriptionId"]).toBeDefined();
    expect(await readFile(event.data.artifact, "utf8")).toContain("# Review");
    expect(received).toHaveLength(1);
    stop.abort();
    await Promise.all(streams);
    const status = await client.callTool({
      name: "probe_status",
      arguments: {},
    });
    expect(status.isError).not.toBe(true);
  } finally {
    stop.abort();
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
