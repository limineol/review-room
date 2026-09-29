# Review Room

A local Codex plugin for adversarial code review discussions. Discover installed coding CLIs, choose the exact harness and model for each reviewer, and start a review at a named checkpoint from a sidebar app or conversation panel.

## Workflow

1. Open **Review discussion** from the sidebar or conversation panel.
2. Enter the repository root, comparison revision, checkpoint name, and intended behavior.
3. Choose two to four reviewers and their models. **Choose with chat** asks the current chat to help.
4. Start the review. The first round is independent; later rounds exchange published findings and rebuttals.
5. Add guidance for subsequent turns, stop a run, or send the discussion to the main chat.

The panel uses the host's theme and typography tokens. Review history is shared across this user's local panels and stored in `~/.local/share/review-room/reviews.sqlite`. No cloud backend or new API key is required. Provider charges and subscription limits follow the selected CLI accounts.

## Supported scope

- Detects Codex, Claude Code, OpenCode, Gemini CLI, Cursor Agent, Factory Droid, Devin, Grok Build, Antigravity, ForgeCode, Hermes, Pi, Oh My Pi, and Slate on PATH and common local binary directories.
- Executes Codex and Claude Code. Other discovered harnesses are labeled discovery-only.
- Codex suggestions come from its local model cache. Claude suggestions are CLI aliases. These are not a claim of account access; custom model IDs are accepted and errors are visible.
- Captures tracked changes against the selected commit plus untracked regular text files. `HEAD` reviews uncommitted work; choose another base to include commits. Git ignored files are excluded.
- The review is limited to a frozen diff, at most 300 KB. It rejects unsupported untracked files rather than silently omitting them. Reviewers cannot inspect surrounding files or execute tests. Binary tracked changes appear only as Git's binary-change notice.
- Two to four reviewers, one to three rounds, three-minute limit per reviewer turn. Responses appear when a turn completes. User messages reach later turns, not a turn already in progress.
- Codex uses a read-only sandbox with shell tools, plugins and user configuration disabled. Claude uses safe mode, no tools, strict MCP configuration and noninteractive denied permissions. Each invocation uses a temporary empty working directory and stdin for the prompt.
- Runs require the MCP process to stay alive. Graceful shutdown marks them interrupted; stale dead process records are detected when read. There is no automatic retry or model fallback.

## Development

Requires Bun 1.3.14 or later and the selected signed-in CLIs. Dependencies are pinned exactly.

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

The built `dist/server.js` and `dist/panel.html` are self-contained except for the Bun runtime and local CLIs. `mcp.json` is the portable manifest; `.codex-plugin/plugin.json` and `.mcp.json` provide Codex compatibility. No edits to global agent instructions are needed.

## Privacy

Discovery reads executable locations and the Codex model cache, not credential files. Starting a review sends the captured source to the explicitly selected providers using existing CLI authentication. Transcripts stay in the local database, which should be treated as source-sensitive. Sharing back to chat is a separate user action. The plugin does not contact production services or databases.
