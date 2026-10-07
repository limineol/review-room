// src/pi-readonly.ts
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
async function checkReadOnlyTool(root, event) {
  if (!["read", "grep", "find", "ls"].includes(event.toolName))
    return {
      block: true,
      reason: "Reviewers may only read and search repository files."
    };
  const supplied = event.input.path;
  if (supplied !== undefined && typeof supplied !== "string")
    return { block: true, reason: "Use a repository file path." };
  const path = supplied ?? ".";
  if (/^[@~]|^file:|[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(path))
    return {
      block: true,
      reason: "Use a plain absolute or repository-relative path."
    };
  try {
    const canonicalRoot = await realpath(root);
    const canonicalPath = await realpath(resolve(canonicalRoot, path));
    const within = relative(canonicalRoot, canonicalPath);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
      return {
        block: true,
        reason: "Reads outside the review repository are disabled."
      };
  } catch {
    return {
      block: true,
      reason: "The repository path could not be verified."
    };
  }
}
function reviewReadOnly(pi) {
  const root = process.env.REVIEW_ROOM_REPO;
  if (!root)
    throw new Error("Review Room repository is missing.");
  pi.on("tool_call", (event) => checkReadOnlyTool(root, event));
  pi.registerCommand("review-room-ready", {
    description: "Review Room read-only guard is loaded",
    handler: async () => {}
  });
}
export {
  reviewReadOnly as default,
  checkReadOnlyTool
};
