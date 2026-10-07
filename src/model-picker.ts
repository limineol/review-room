import { App } from "@modelcontextprotocol/ext-apps";
import { pickerSchema } from "./model-picker-schema";
import { avatar, el, icon, iconButton, theme } from "./ui";
import type { z } from "zod";

declare global {
  interface Window {
    openai?: { requestClose?: () => void | Promise<void> };
  }
}
const app = new App({ name: "Review Room model picker", version: "0.3.1" });
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const refreshButton = iconButton("refresh", "Refresh models");
get("refresh-control").append(refreshButton);
get("model-search-field").prepend(icon("search"));
let state: z.infer<typeof pickerSchema> | undefined;
let selected = new Set<string>();
let busy = false;
function render() {
  get<HTMLButtonElement>("save").disabled = busy || !state;
  refreshButton.disabled = busy || !state;
  get("count").textContent = `${selected.size} selected`;
  if (!state) return;
  get("title").textContent =
    `${state.harness === "codex" ? "Codex" : "Claude"} models`;
  get("provider-icon").replaceChildren(avatar(state.harness));
  const filter = get<HTMLInputElement>("search").value.trim().toLowerCase();
  const choices = [...state.choices];
  const known = new Set(choices.map((m) => m.id));
  for (const id of new Set([...state.selected, ...selected])) {
    if (!known.has(id))
      choices.push({
        id,
        name: id,
        description: state.selected.includes(id)
          ? "Previously saved · currently unavailable"
          : "Unavailable · uncheck before saving",
      });
  }
  const list = get("choices");
  list.replaceChildren();
  for (const model of choices.filter((m) =>
    `${m.name} ${m.description} ${m.id}`.toLowerCase().includes(filter),
  )) {
    const label = el("label", "choice");
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.value = model.id;
    checkbox.checked = selected.has(model.id);
    checkbox.disabled = busy;
    checkbox.onchange = () => {
      if (checkbox.checked) selected.add(model.id);
      else selected.delete(model.id);
      get("count").textContent = `${selected.size} selected`;
      get("status").textContent = "Unsaved changes";
    };
    const text = el("span", "choice-text");
    text.append(
      el("span", "choice-name", model.name),
      el("span", "choice-description", model.description),
    );
    label.append(checkbox, text);
    list.append(label);
  }
  if (!list.childElementCount)
    list.append(
      el(
        "p",
        "no-models",
        filter
          ? "No matching models."
          : "No models available. Sign in to the harness, then refresh.",
      ),
    );
}
async function closeAfterSave() {
  if (typeof window.openai?.requestClose !== "function") {
    get("status").textContent = "Saved. You can close this window.";
    return;
  }
  try {
    await window.openai.requestClose();
  } catch {
    get("status").textContent = "Saved. You can close this window.";
  }
}
async function action(save: boolean) {
  if (busy || !state) return;
  busy = true;
  let saved = false;
  get("status").textContent = save ? "Saving…" : "Refreshing…";
  get<HTMLButtonElement>("save").textContent = save
    ? "Saving…"
    : "Save changes";
  get("error").textContent = "";
  render();
  try {
    const response = await app.callServerTool({
      name: save ? "review_models_save" : "review_models_read",
      arguments: {
        harness: state.harness,
        ...(save ? { selected: [...selected] } : { refresh: true }),
      },
    });
    if (response.isError)
      throw new Error(
        response.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      );
    state = pickerSchema.parse(response.structuredContent);
    if (save) selected = new Set(state.selected);
    get("error").textContent = state.error ?? "";
    get("status").textContent = save
      ? "Changes saved"
      : state.stale
        ? "Using the last available catalog"
        : "Models updated";
    saved = save;
  } catch (error) {
    get("error").textContent =
      error instanceof Error ? error.message : "Unable to update models.";
    get("status").textContent = "Your selection has been kept";
  } finally {
    busy = false;
    get<HTMLButtonElement>("save").textContent = "Save changes";
    render();
  }
  if (saved) void closeAfterSave();
}
app.ontoolresult = (response) => {
  if (state) return;
  const parsed = pickerSchema.safeParse(response.structuredContent);
  if (!parsed.success || response.isError) {
    get("status").textContent = "Unable to load models";
    get("error").textContent =
      "Close this picker and choose models again to retry.";
    return;
  }
  state = parsed.data;
  selected = new Set(state.selected);
  get("error").textContent = state.error ?? "";
  get("status").textContent = state.stale ? "Using saved selections" : "";
  render();
};
app.addEventListener("hostcontextchanged", () => theme(app));
refreshButton.onclick = () => void action(false);
get("save").onclick = () => void action(true);
get<HTMLInputElement>("search").oninput = render;
render();
try {
  await app.connect();
  theme(app);
} catch {
  get("error").textContent = "Could not connect to Review Room.";
}
