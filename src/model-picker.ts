import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
import { pickerSchema } from "./model-picker-schema";
import type { z } from "zod";
const app = new App({ name: "Review Room model picker", version: "0.2.1" });
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let state: z.infer<typeof pickerSchema> | undefined;
let selected = new Set<string>();
let busy = false;
function render() {
  get<HTMLButtonElement>("save").disabled = busy || !state;
  get<HTMLButtonElement>("refresh").disabled = busy || !state;
  get("count").textContent = `${selected.size} selected`;
  if (!state) return;
  get("title").textContent =
    `Allowed ${state.harness === "codex" ? "Codex" : "Claude"} models`;
  const filter = get<HTMLInputElement>("search").value.trim().toLowerCase();
  const choices = [...state.choices];
  const known = new Set(choices.map((m) => m.id));
  for (const id of new Set([...state.selected, ...selected])) {
    if (!known.has(id))
      choices.push({
        id,
        name: id,
        description: state.selected.includes(id)
          ? "Previously saved · unavailable in the current catalog"
          : "Unavailable · uncheck this model before saving",
      });
  }
  const list = get("choices");
  list.replaceChildren();
  for (const model of choices.filter((m) =>
    `${m.name} ${m.description} ${m.id}`.toLowerCase().includes(filter),
  )) {
    const label = document.createElement("label");
    label.className = "choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(model.id);
    checkbox.disabled = busy;
    checkbox.onchange = () => {
      if (checkbox.checked) selected.add(model.id);
      else selected.delete(model.id);
      get("count").textContent = `${selected.size} selected`;
      get("status").textContent = "Unsaved selection";
    };
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = model.name;
    const description = document.createElement("span");
    description.textContent = model.description;
    text.append(name, description);
    label.append(checkbox, text);
    list.append(label);
  }
  if (!list.childElementCount)
    list.textContent = filter
      ? "No matching models."
      : "No models available. Refresh after signing in to the harness.";
}
async function action(save: boolean) {
  if (busy || !state) return;
  busy = true;
  get("status").textContent = save ? "Saving…" : "Refreshing catalog…";
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
      ? "Selection saved."
      : state.stale
        ? "Showing saved catalog data."
        : "Catalog refreshed. Save to apply your selection.";
  } catch (error) {
    get("error").textContent =
      error instanceof Error ? error.message : "Unable to update models.";
    get("status").textContent = "Your selection has been kept.";
  } finally {
    busy = false;
    render();
  }
}
app.ontoolresult = (response) => {
  if (state) return;
  const parsed = pickerSchema.safeParse(response.structuredContent);
  if (!parsed.success || response.isError) {
    get("status").textContent = "Unable to load model settings.";
    get("error").textContent =
      "Close this picker and choose models again to retry.";
    return;
  }
  state = parsed.data;
  selected = new Set(state.selected);
  get("error").textContent = state.error ?? "";
  get("status").textContent = state.stale
    ? "Catalog unavailable. Existing selections are preserved."
    : "Choose any models you want to allow.";
  render();
};
function theme() {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}
app.addEventListener("hostcontextchanged", theme);
get("refresh").onclick = () => void action(false);
get("save").onclick = () => void action(true);
get<HTMLInputElement>("search").oninput = render;
try {
  await app.connect();
  theme();
} catch {
  get("error").textContent = "Could not connect to Review Room.";
}
