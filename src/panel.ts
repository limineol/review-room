import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { stateSchema, runSchema, type Run } from "./schema";
const app = new App({ name: "Review Room", version: "0.2.0" });
const extensions = new OpenAIExtensions(app);
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let runs: Run[] = [],
  selected: string | undefined,
  current: Run | undefined,
  busy = false,
  renderedId: string | undefined,
  count = 0,
  historyKey = "";
async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = await app.callServerTool({ name, arguments: args });
  if (r.isError)
    throw new Error(
      r.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    );
  return r.structuredContent;
}
function error(value: unknown) {
  get("error").textContent =
    value instanceof Error ? value.message : String(value);
}
function render() {
  const key = runs.map((r) => r.id + ":" + r.status).join("|");
  const history = get<HTMLSelectElement>("history");
  if (key !== historyKey) {
    history.replaceChildren(new Option("Choose a review", ""));
    for (const r of runs)
      history.add(new Option(`${r.label} · ${r.status}`, r.id));
    historyKey = key;
  }
  history.value = selected ?? "";
  const run = current?.id === selected ? current : undefined;
  get("empty").hidden = !!run;
  get("discussion").hidden = !run;
  get("status").textContent = run ? run.status : "No active review";
  if (!run) return;
  get("participants").textContent = run.reviewers
    .map(
      (r) =>
        `${r.name} · ${r.harness}/${r.model}${r.state === "running" ? " · reviewing" : ""}`,
    )
    .join("\n");
  get("artifact").textContent = run.artifact
    ? `Review saved: ${run.artifact}`
    : "";
  get<HTMLButtonElement>("stop").hidden = !["running", "ready"].includes(
    run.status,
  );
  const feed = get("messages");
  const changed = renderedId !== run.id;
  const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  if (changed) {
    feed.replaceChildren();
    count = 0;
  }
  for (const m of run.messages.slice(count)) {
    const article = document.createElement("article");
    article.className =
      m.kind === "activity" || m.kind === "status"
        ? "system-message"
        : "message";
    const label = document.createElement("div");
    label.className = "speaker";
    label.textContent = `${m.sender}${m.recipient === "all" ? "" : ` → ${m.recipient}`}`;
    const body = document.createElement("div");
    body.className = "message-body";
    body.innerHTML = DOMPurify.sanitize(
      marked.parse(m.text, { async: false }),
      {
        ALLOWED_TAGS: [
          "p",
          "br",
          "strong",
          "em",
          "code",
          "pre",
          "ul",
          "ol",
          "li",
          "blockquote",
          "h1",
          "h2",
          "h3",
          "h4",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
          "hr",
        ],
        ALLOWED_ATTR: [],
      },
    );
    article.append(label, body);
    feed.append(article);
  }
  count = run.messages.length;
  renderedId = run.id;
  if (changed) feed.scrollTop = 0;
  else if (follow) feed.scrollTop = feed.scrollHeight;
}
async function load() {
  if (!selected) {
    current = undefined;
    return;
  }
  const id = selected;
  const run = runSchema.parse(
    await tool("review_room_discussion", { runId: id }),
  );
  if (selected === id) current = run;
}
async function action(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  get("error").textContent = "";
  try {
    await fn();
  } catch (e) {
    error(e);
  } finally {
    busy = false;
    render();
  }
}
function receive(data: unknown) {
  const parsed = stateSchema.safeParse(data);
  if (!parsed.success) return;
  runs = parsed.data.runs;
  if (parsed.data.selectedRunId) selected = parsed.data.selectedRunId;
  render();
}
app.ontoolresult = (r) => {
  receive(r.structuredContent);
  void action(load);
};
function theme() {
  const c = app.getHostContext();
  if (c?.theme) applyDocumentTheme(c.theme);
  if (c?.styles?.variables) applyHostStyleVariables(c.styles.variables);
  if (c?.styles?.css?.fonts) applyHostFonts(c.styles.css.fonts);
}
app.addEventListener("hostcontextchanged", theme);
get<HTMLSelectElement>("history").onchange = () => {
  selected = get<HTMLSelectElement>("history").value || undefined;
  void action(load);
};
get("request").onclick = () =>
  void action(async () => {
    if (!extensions.message)
      throw new Error(
        "Ask the agent in this chat to run an adversarial review using Review Room.",
      );
    await extensions.message.send({
      role: "user",
      content: [
        {
          type: "text",
          text: "Run an adversarial review of the current changes using Review Room. Choose reviewers from my enabled harnesses and models, discuss their findings, and evaluate the feedback.",
        },
      ],
    });
  });
get("stop").onclick = () =>
  void action(async () => {
    if (!selected) return;
    await tool("review_stop", { runId: selected });
    await load();
  });
try {
  await app.connect();
  theme();
  const c = app.getHostContext();
  if (
    c?.availableDisplayModes?.includes("fullscreen") &&
    c.displayMode !== "fullscreen"
  )
    await app.requestDisplayMode({ mode: "fullscreen" });
  setInterval(() => {
    if (busy || document.hidden) return;
    busy = true;
    void tool("review_room_state")
      .then(async (data) => {
        receive(data);
        await load();
        render();
      })
      .catch(error)
      .finally(() => {
        busy = false;
      });
  }, 1500);
} catch (e) {
  error(e);
}
