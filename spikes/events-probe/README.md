# Agent-driven review event proof

This isolated spike tests the revised architecture before changing the production Review Room panel or orchestration. It is not the new production review engine.

- A short MCP tool launches a background read-only Claude Opus process.
- The reviewer reads the actual working directory using restricted Read/Grep/Glob tools.
- The service writes a Markdown artifact and emits `review.completed`.
- `events/list` and `events/stream` implement the draft push-event contract, including per-request correlation, filtering, replay within the current process, heartbeats, and cancellation.
- MCP 2026-07-28 discovery and legacy initialize both work. The SDK's typed discovery result drops the draft `events` field; the raw server response correctly advertises it.
- This is a local stdio push test. It does not implement or claim signed webhook delivery.

## Run

```sh
bun install --frozen-lockfile
bun build spikes/events-probe/server.ts --target=bun --outfile=dist/events-probe.js
bunx tsc --noEmit -p spikes/events-probe
bun test spikes/events-probe/protocol.test.ts
REVIEW_ROOM_PROBE_OUTPUT=/absolute/path/to/probe-data bun spikes/events-probe/smoke.ts
```

The smoke test launches a real Opus review of a small fixture. Set `REVIEW_ROOM_DISCOVERY_ONLY=1` to test discovery without an inference call. State defaults to `~/.local/share/review-room/events-probe` when launched through the plugin. Protocol tracing records method names only, not request bodies or credentials.

## Evidence and boundaries

The local smoke test received a real completion event and an artifact identifying the seeded empty-array defect. Automated coverage checks modern discovery, event catalog, run filters, request correlation, artifact creation, cancellation, and continued tool responsiveness.

The installed Codex app-server protocol exposes experimental `mcpServer/event/stream/start`, `mcpServer/event/stream/stop`, and `mcpServer/event/stream/notification`. That proves an event-stream bridge exists, not that the desktop host automatically feeds its events into a chat agent or resumes an idle turn. A fresh native test chat confirmed that the probe tools are callable but found no event-subscription tool, event catalog, or subscription control in the plugin settings. Automatic same-chat continuation remains unproven; the missing host subscription entrypoint is the blocker.

References:
- https://developers.openai.com/plugins/build/mcp-events
- https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md

The documented ChatGPT integration supports signed webhooks only. The locally installed Codex stream bridge must be verified independently; do not equate the two.

## Intentionally not implemented in this spike

Native plugin settings, enabled model selection, persistent reviewer sessions, peer dialogue, durable subscriptions/replay after restart, UI event rendering, multi-cycle review orchestration, and automatic return to the originating chat. These follow only after proving the host integration. Existing production plugin functionality is preserved during the probe.
