import { marked } from "marked";
import DOMPurify from "dompurify";
import { avatar, el, icon, modelName, statusBadge, statusLabels } from "./ui";
import type { Message, Participant, Run, RunSummary } from "./schema";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
export function projectName(repo: string) {
  return repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
}
export function reviewDate(created: string) {
  return dateFormat.format(new Date(created));
}
const speakerName = (name: string) =>
  name === "agent"
    ? "Main agent"
    : name.charAt(0).toUpperCase() + name.slice(1);

export function reviewCard(run: RunSummary, open: () => void) {
  const card = el("button", "review-card");
  card.type = "button";
  card.dataset.runId = run.id;
  card.setAttribute(
    "aria-label",
    `Open review: ${run.label}. ${statusLabels[run.status]}. ${projectName(run.repo)}. ${run.reviewers.map((r) => modelName(r.model)).join(", ")}. ${run.turns} ${run.turns === 1 ? "turn" : "turns"}.`,
  );
  const top = el("span", "card-top");
  top.append(
    statusBadge(run.status),
    el("span", "card-date", reviewDate(run.created)),
  );
  const title = el(
    "span",
    "card-title",
    run.label.charAt(0).toUpperCase() + run.label.slice(1),
  );
  const project = el("span", "card-project");
  project.append(icon("folder"), el("span", "", projectName(run.repo)));
  project.title = run.repo;
  const bottom = el("span", "card-bottom");
  const reviewers = el("span", "card-reviewers");
  for (const reviewer of run.reviewers) {
    const badge = avatar(reviewer.harness);
    badge.title = `${speakerName(reviewer.name)} · ${modelName(reviewer.model)}`;
    reviewers.append(badge);
  }
  const names = [...new Set(run.reviewers.map((r) => modelName(r.model)))].join(
    " · ",
  );
  reviewers.append(el("span", "card-models", names));
  const turns = el(
    "span",
    "card-turns",
    `${run.turns} ${run.turns === 1 ? "turn" : "turns"}`,
  );
  bottom.append(reviewers, turns, icon("arrow"));
  card.append(top, title, project, bottom);
  card.onclick = open;
  return card;
}

export function participantChip(reviewer: Participant) {
  const chip = el("span", "participant");
  chip.append(
    avatar(reviewer.harness),
    el("span", "", modelName(reviewer.model)),
  );
  chip.title = `${speakerName(reviewer.name)} · ${reviewer.harness === "claude" ? "Claude Code" : "Codex"}`;
  if (reviewer.state === "running") {
    const indicator = el("span", "working-dot");
    indicator.append(el("span", "sr-only", "Reviewing"));
    chip.append(indicator);
  }
  if (reviewer.state === "failed" || reviewer.state === "stopped")
    chip.append(
      el(
        "span",
        "participant-state",
        reviewer.state === "failed" ? "Failed" : "Stopped",
      ),
    );
  return chip;
}

function markdown(text: string) {
  const body = el("div", "message-body");
  body.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "s",
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
      "h5",
      "h6",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
    ],
    ALLOWED_ATTR: ["start"],
  });
  for (const table of body.querySelectorAll("table")) {
    const wrapper = el("div", "table-scroll");
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  return body;
}

function messageBubble(message: Message, run: Run, isBrief: boolean) {
  const reviewer = run.reviewers.find((r) => r.name === message.sender);
  const article = el(
    "article",
    `message ${message.sender === "agent" ? "from-agent" : "from-reviewer"}${message.kind === "error" ? " message-error" : ""}`,
  );
  article.dataset.messageId = String(message.id);
  const content = el("div", "message-content");
  const byline = el("div", "message-byline");
  const recipient =
    message.recipient === "all" || message.recipient === "agent"
      ? ""
      : ` → ${speakerName(message.recipient)}`;
  byline.append(el("span", "speaker", speakerName(message.sender) + recipient));
  const time = el(
    "time",
    "message-time",
    timeFormat.format(new Date(message.time)),
  );
  time.dateTime = message.time;
  time.title = new Date(message.time).toLocaleString();
  byline.append(time);
  content.append(byline);
  if (isBrief) {
    const brief = el("details", "message-bubble brief");
    const summary = el("summary");
    summary.append(icon("file"), el("span", "", "Review brief"), icon("arrow"));
    brief.append(summary, markdown(message.text));
    content.append(brief);
  } else {
    const bubble = el("div", "message-bubble");
    bubble.append(markdown(message.text));
    content.append(bubble);
  }
  article.append(avatar(reviewer?.harness), content);
  return article;
}

export function appendDiscussion(feed: HTMLElement, run: Run, start: number) {
  const firstAgentMessage = run.messages.findIndex(
    (message) => message.sender === "agent" && message.kind === "message",
  );
  for (let index = start; index < run.messages.length; index++) {
    const message = run.messages[index]!;
    if (message.kind === "activity") {
      let activity = feed.querySelector<HTMLDetailsElement>(
        ":scope > .activity-group:last-child",
      );
      if (!activity || activity.dataset.sender !== message.sender) {
        activity = el("details", "activity-group");
        activity.dataset.sender = message.sender;
        const summary = el("summary");
        summary.append(
          icon("clock"),
          el("span", "activity-label"),
          icon("arrow"),
        );
        activity.append(summary, el("ol", "activity-items"));
        feed.append(activity);
      }
      const items = activity.querySelector("ol")!;
      items.append(el("li", "", message.text));
      activity.querySelector(".activity-label")!.textContent =
        `${speakerName(message.sender)} · ${items.childElementCount} ${items.childElementCount === 1 ? "update" : "updates"}`;
      continue;
    }
    if (message.kind === "status") {
      const status = el("div", "timeline-status");
      status.append(icon("clock"), el("span", "", message.text));
      feed.append(status);
      continue;
    }
    feed.append(messageBubble(message, run, index === firstAgentMessage));
  }
}
