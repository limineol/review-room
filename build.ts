import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const server = await Bun.build({
  entrypoints: ["src/server.ts"],
  outdir: "dist",
  target: "bun",
  naming: "server.js",
});
if (!server.success)
  throw new AggregateError(server.logs, "Server build failed");
const probe = await Bun.build({
  entrypoints: ["spikes/events-probe/server.ts"],
  outdir: "dist",
  target: "bun",
  naming: "events-probe.js",
});
if (!probe.success)
  throw new AggregateError(probe.logs, "Event probe build failed");
const panel = await Bun.build({
  entrypoints: ["src/panel.ts"],
  target: "browser",
  minify: true,
});
if (!panel.success || !panel.outputs[0])
  throw new AggregateError(panel.logs, "Panel build failed");
const css = await readFile(
  "node_modules/@openai/mcp-extensions/styles.css",
  "utf8",
);
const script = (await panel.outputs[0].text()).replaceAll(
  "</script",
  "<\\/script",
);
const styles = css + (await readFile("src/panel.css", "utf8"));
const html = (await readFile("src/panel.html", "utf8"))
  .replace("/*SCRIPT*/", () => script)
  .replace("/*STYLES*/", () => styles);
await writeFile("dist/panel.html", html);
