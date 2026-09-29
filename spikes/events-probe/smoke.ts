import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.REVIEW_ROOM_PROBE_OUTPUT;
if (!root) throw new Error("Set REVIEW_ROOM_PROBE_OUTPUT");
const repo = join(root, "fixture");
await mkdir(repo, { recursive: true });
await writeFile(
  join(repo, "average.ts"),
  "// Contract: an empty array returns 0.\nexport function average(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n",
);
const client = new Client(
  { name: "review-room-probe-client", version: "0.0.1" },
  { versionNegotiation: { mode: "auto" } },
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dir, "../../dist/events-probe.js")],
  env,
  stderr: "inherit",
});
const notificationSchema = z.object({
  eventId: z.string(),
  data: z.object({
    runId: z.string(),
    status: z.string(),
    artifact: z.string(),
    summary: z.string(),
  }),
});
let resolveEvent: (
  event: z.infer<typeof notificationSchema>,
) => void = () => {};
const arrived = new Promise<z.infer<typeof notificationSchema>>((resolve) => {
  resolveEvent = resolve;
});
client.setNotificationHandler(
  "notifications/events/event",
  { params: notificationSchema },
  (event) => resolveEvent(event),
);
await client.connect(transport);
console.log("DISCOVER", JSON.stringify(client.getDiscoverResult()));
console.log(
  "EVENTS",
  JSON.stringify(
    await client.request(
      { method: "events/list", params: {} },
      z.object({
        events: z.array(
          z.object({ name: z.string(), delivery: z.array(z.string()) }),
        ),
      }),
    ),
  ),
);
if (process.env.REVIEW_ROOM_DISCOVERY_ONLY === "1") {
  await client.close();
  process.exit(0);
}
const started = await client.callTool({
  name: "probe_start_review",
  arguments: {
    repo,
    prompt:
      "Read average.ts and review it against the contract in its first line.",
  },
});
const text = started.content.find((c) => c.type === "text");
if (!text || text.type !== "text") throw new Error("Missing start result");
const { runId } = z.object({ runId: z.string() }).parse(JSON.parse(text.text));
console.log("STARTED", runId);
const stop = new AbortController();
void client
  .request(
    {
      method: "events/stream",
      params: { name: "review.completed", arguments: { runId }, cursor: null },
    },
    z.object({}),
    { signal: stop.signal, timeout: 200000 },
  )
  .catch((error) => {
    if (!stop.signal.aborted) console.error(error);
  });
const deadline = setTimeout(() => {
  console.error("Event delivery timed out");
  process.exitCode = 1;
  void client.close();
}, 190000);
try {
  const event = await arrived;
  console.log("RECEIVED", JSON.stringify(event));
} finally {
  clearTimeout(deadline);
  stop.abort();
  await client.close();
}
