# Review Room

A native Codex plugin for agent-controlled adversarial reviews. The agent in your chat discovers enabled local models, writes review prompts, launches reviewers, discusses their findings, collects a Markdown artifact, and implements appropriate feedback within your task's scope.

The discussion panel shows progress and dialogue. **Request review** sends a request to the current chat agent. There is no review-configuration form or second chat composer in the panel.

## Native settings

Open the plugin's Settings to enable Codex and/or Claude Code and allow exact model IDs or CLI aliases. The agent chooses among these combinations. Discovery distinguishes installed executables, model suggestions, and configured permission; it does not promise account access.

Settings also control maximum reviewers (1–4), reviewer turns per cycle (1–30), and seconds per turn (30–600). **Reuse reviewer sessions between cycles** defaults off. Within a discussion, sessions continue for follow-ups. Cross-cycle reuse, when enabled, is scoped to the same room, repository, reviewer name, harness, and model.

New installations start with no enabled reviewers. On Dani's installation, the previously authorized GPT-5.5/Codex and Opus/Claude combinations are seeded only if settings have never been saved.

## Agent tools

- `review_discover`: installed harnesses, enabled combinations, and limits.
- `review_prompt_guide`: instructions for prompting and driving the loop.
- `review_start`: start one or more background reviewers on actual repository files.
- `review_send`: send agent follow-up questions to one reviewer or all.
- `review_wait`: wait for published messages or a state change, using a cursor.
- `review_collect`: close a ready cycle and save its Markdown discussion artifact.
- `review_read` / `review_stop`: read status and messages, or cancel.
- `open_review_room`: show the native panel, optionally selecting a run.

A checkpoint means "review now," not a stored code snapshot. The reviewer reads the live repository; the prompt should specify files or the comparison ref. Avoid changing the same area during inspection, or ask for revalidation after changes.

Reviewers return findings and optional addressed questions. Peer questions and their answers are routed by the service without the main agent having to copy every message. The main agent decides when to collect, implement fixes, and request another cycle. The turn budget prevents unbounded peer loops.

## Runtime and safety

Targets macOS/Linux with Bun 1.3.14 or later and signed-in local CLI accounts. Codex runs in a read-only sandbox with user configuration/rules and plugins disabled. Claude uses safe/restricted mode, Read/Grep/Glob only, and strict MCP configuration. Both can read actual code; neither is instructed to edit files or run tests. The main chat agent owns implementation and verification.

The native panel applies host theme, font, and styling tokens. Published messages are rendered as sanitized Markdown; private model reasoning is not displayed. Artifact files and the SQLite database are local. Source is sent through the selected CLI accounts and remains subject to those providers' terms and limits.

Jobs depend on the owning MCP process remaining alive. A stopped process interrupts its work. There is no idle-chat event wakeup: the agent actively uses `review_wait`. The event-protocol experiment remains in `spikes/events-probe` for reference and is no longer loaded by the production plugin.

Data: `~/.local/share/review-room/agent-reviews.sqlite`. Artifacts: `~/.local/share/review-room/artifacts/`. Previous v0.1 history remains in `reviews.sqlite`; it is not migrated or deleted.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun test
```

The build bundles the MCP server and native panel. `mcp.json` is the portable manifest; `.mcp.json` and `.codex-plugin/plugin.json` provide Codex compatibility. Dependencies are exactly pinned. Zod is aligned with the Extensions SDK's supported version to keep native settings schemas type-compatible.
