import {
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type App,
} from "@modelcontextprotocol/ext-apps";
import openai from "../assets/openai.svg";
import claude from "../assets/claude.svg";
import type { Participant, Run } from "./schema";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const paths = {
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>',
  back: '<path d="m14 5-7 7 7 7M7 12h14"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8M20 3v5h-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8 9 9 0 0 1-3.5-.7L4 20l1.2-4.5a9 9 0 0 1-.7-3.5 8 8 0 0 1 15.5-.5Z"/><path d="M8 10h8M8 14h5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 13h8M8 17h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
} as const;
export function icon(name: keyof typeof paths) {
  const span = el("span", "icon");
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
  return span;
}
export function avatar(harness?: Participant["harness"]) {
  const span = el("span", `avatar ${harness ?? "agent"}`);
  span.setAttribute("aria-hidden", "true");
  if (harness === "pi") span.textContent = "π";
  else if (harness === "opencode") span.append(icon("code"));
  else if (harness) span.innerHTML = harness === "claude" ? claude : openai;
  else span.append(icon("chat"));
  return span;
}
export function iconButton(name: keyof typeof paths, label: string) {
  const button = el("button", "icon-button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  return button;
}
export function modelName(model: string): string {
  if (model.includes("/"))
    return modelName(model.slice(model.lastIndexOf("/") + 1));
  if (model.startsWith("gpt-"))
    return model
      .replace(/^gpt-/, "GPT-")
      .replace(
        /-(sol|astra|luna|terra)$/i,
        (_, family: string) =>
          ` ${family.charAt(0).toUpperCase()}${family.slice(1)}`,
      );
  if (model.startsWith("claude-"))
    return model
      .replace(/^claude-/, "")
      .split("-")
      .map((word, index) =>
        index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
      )
      .join(" ")
      .replace(/(\d) (\d)/g, "$1.$2");
  if (["opus", "sonnet", "haiku", "fable", "default"].includes(model))
    return model.charAt(0).toUpperCase() + model.slice(1);
  return model;
}
export const statusLabels: Record<Run["status"], string> = {
  running: "Reviewing",
  ready: "Ready",
  collecting: "Saving",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};
export function statusBadge(status: Run["status"]) {
  const span = el("span", `status-badge ${status}`, statusLabels[status]);
  span.prepend(el("span", "status-dot"));
  return span;
}
export function theme(app: App) {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}
