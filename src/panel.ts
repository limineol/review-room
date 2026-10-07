import { App } from "@modelcontextprotocol/ext-apps";
import { stateSchema, runSchema, type Run, type RunSummary } from "./schema";
import { el, icon, iconButton, statusBadge, theme } from "./ui";
import {
  reviewCard,
  participantChip,
  appendDiscussion,
  projectName,
  reviewDate,
} from "./panel-view";

const app = new App({ name: "Review Room", version: "0.3.1" });
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const refreshButton = iconButton("refresh", "Refresh reviews");
const backButton = iconButton("back", "All reviews");
const stopButton = iconButton("stop", "Stop review");
get("overview-actions").append(refreshButton);
get("back-control").append(backButton);
get("review-actions").append(stopButton);
get("review-search-field").prepend(icon("search"));
get("empty-icon").append(icon("chat"));
get("artifact")
  .querySelector("summary")!
  .append(icon("file"), el("span", "", "Review saved"), icon("arrow"));
let runs: RunSummary[] = [],
  selected: string | undefined,
  current: Run | undefined;
let busy = false,
  polling = false,
  revision = 0,
  loaded = false;
let cardsKey = "",
  renderedCount = 0,
  renderedId: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError)
    throw new Error(
      result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    );
  return result.structuredContent;
}
const pollErrors = new Set<string>();
function error(value: unknown, fromPoll = false) {
  const target = selected ? "discussion-error" : "overview-error";
  if (fromPoll && get(target).textContent && !pollErrors.has(target)) return;
  if (fromPoll) pollErrors.add(target);
  else pollErrors.delete(target);
  get(target).textContent =
    value instanceof Error ? value.message : String(value);
}
function render() {
  get("overview").hidden = !!selected;
  get("discussion").hidden = !selected;
  refreshButton.disabled = busy;
  stopButton.disabled = busy;
  if (!selected) {
    const query = get<HTMLInputElement>("review-search")
      .value.trim()
      .toLowerCase();
    const filtered = runs.filter((r) =>
      `${r.label} ${r.repo} ${r.reviewers.map((p) => `${p.name} ${p.model}`).join(" ")}`
        .toLowerCase()
        .includes(query),
    );
    const active = runs.filter((r) =>
      ["running", "ready", "collecting"].includes(r.status),
    ).length;
    get("overview-meta").textContent = loaded
      ? `${runs.length} ${runs.length === 1 ? "review" : "reviews"}${active ? ` · ${active} active` : ""}`
      : "Loading reviews…";
    const key = JSON.stringify([filtered, query]);
    if (key !== cardsKey) {
      get("cards").replaceChildren(
        ...filtered.map((run) => reviewCard(run, () => void open(run.id))),
      );
      cardsKey = key;
    }
    get("empty").hidden = !loaded || filtered.length > 0;
    get("empty-title").textContent = query
      ? "No matching reviews"
      : "No reviews yet";
    get("empty-description").textContent = query
      ? "Try a different title, project, or model."
      : "Reviews started in your chat will appear here.";
    return;
  }
  const summary =
    current?.id === selected ? current : runs.find((r) => r.id === selected);
  get("review-title").textContent = summary?.label ?? "Loading review…";
  get("review-meta").textContent = summary
    ? `${projectName(summary.repo)} · ${reviewDate(summary.created)} · ${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`
    : "";
  get("review-status").replaceChildren(
    ...(summary ? [statusBadge(summary.status)] : []),
  );
  get("participants").replaceChildren(
    ...(summary?.reviewers.map(participantChip) ?? []),
  );
  stopButton.hidden =
    !summary || !["running", "ready"].includes(summary.status);
  const run = current?.id === selected ? current : undefined;
  get("artifact").hidden = !run?.artifact;
  get("artifact").closest<HTMLElement>("footer")!.hidden = !run?.artifact;
  get("artifact").querySelector("code")!.textContent = run?.artifact ?? "";
  const feed = get("messages");
  if (!run) {
    if (renderedId !== selected) {
      feed.replaceChildren(
        el("p", "conversation-empty", "Loading discussion…"),
      );
      renderedCount = 0;
    }
    return;
  }
  const changed = renderedId !== run.id;
  const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  if (changed || run.messages.length < renderedCount) {
    feed.replaceChildren();
    renderedCount = 0;
    get<HTMLDetailsElement>("artifact").open = false;
  }
  if (renderedCount === 0 && run.messages.length) feed.replaceChildren();
  appendDiscussion(feed, run, renderedCount);
  if (!run.messages.length) {
    const text =
      run.status === "running"
        ? "Reviewers are getting started…"
        : "No messages in this review.";
    const placeholder = feed.querySelector(".conversation-empty");
    if (!placeholder) feed.append(el("p", "conversation-empty", text));
    else if (placeholder.textContent !== text) placeholder.textContent = text;
  }
  if (changed) feed.scrollTop = 0;
  else if (follow && renderedCount !== run.messages.length)
    feed.scrollTop = feed.scrollHeight;
  renderedCount = run.messages.length;
  renderedId = run.id;
}
async function load() {
  if (!selected) return;
  const id = selected,
    requestRevision = revision;
  const run = runSchema.parse(
    await tool("review_room_discussion", { runId: id }),
  );
  if (selected === id && revision === requestRevision) current = run;
}
async function open(id: string) {
  selected = id;
  current = undefined;
  revision++;
  get("discussion-error").textContent = "";
  render();
  get("review-title").focus({ preventScroll: true });
  try {
    await load();
    render();
  } catch (e) {
    if (selected === id) error(e, true);
  }
}
function receive(data: unknown) {
  const state = stateSchema.parse(data);
  runs = state.runs;
  loaded = true;
  if (state.selectedRunId && state.selectedRunId !== selected) {
    selected = state.selectedRunId;
    current = undefined;
    revision++;
  }
}
async function refresh() {
  const requestRevision = revision;
  const data = await tool("review_room_state");
  if (requestRevision !== revision) return;
  receive(data);
  await load();
  if (requestRevision !== revision) return;
  for (const target of pollErrors) get(target).textContent = "";
  pollErrors.clear();
  render();
}
async function action(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  revision++;
  pollErrors.clear();
  get("overview-error").textContent = "";
  get("discussion-error").textContent = "";
  render();
  try {
    await fn();
  } catch (e) {
    error(e);
  } finally {
    busy = false;
    render();
  }
}
app.ontoolresult = (result) => {
  try {
    receive(result.structuredContent);
    render();
    void load()
      .then(render)
      .catch((e) => error(e));
  } catch (e) {
    error(e);
  }
};
app.addEventListener("hostcontextchanged", () => theme(app));
get<HTMLInputElement>("review-search").oninput = render;
refreshButton.onclick = () => void action(refresh);
backButton.onclick = () => {
  const id = selected;
  selected = undefined;
  current = undefined;
  revision++;
  render();
  const card = [
    ...get("cards").querySelectorAll<HTMLButtonElement>("button"),
  ].find((card) => card.dataset.runId === id);
  card?.focus({ preventScroll: true });
};
stopButton.onclick = () =>
  void action(async () => {
    if (!selected) return;
    await tool("review_stop", { runId: selected });
    await refresh();
  });
app.onteardown = async () => {
  clearInterval(timer);
  return {};
};
try {
  await app.connect();
  theme(app);
  const context = app.getHostContext();
  if (
    context?.availableDisplayModes?.includes("fullscreen") &&
    context.displayMode !== "fullscreen"
  )
    await app.requestDisplayMode({ mode: "fullscreen" });
  timer = setInterval(() => {
    if (busy || polling || document.hidden) return;
    polling = true;
    void refresh()
      .catch((e) => error(e, true))
      .finally(() => {
        polling = false;
      });
  }, 1500);
  await refresh();
} catch (e) {
  error(e, true);
}
