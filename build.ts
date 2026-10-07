import { writeNotices } from "./scripts/notices";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const server = await Bun.build({
  entrypoints: ["src/server.ts"],
  outdir: "dist",
  target: "bun",
  naming: "server.js",
  metafile: true,
});
if (!server.success)
  throw new AggregateError(server.logs, "Server build failed");
const piGuard = await Bun.build({
  entrypoints: ["src/pi-readonly.ts"],
  outdir: "dist",
  target: "node",
  naming: "pi-readonly.js",
});
if (!piGuard.success)
  throw new AggregateError(piGuard.logs, "Pi guard build failed");
const probe = await Bun.build({
  entrypoints: ["spikes/events-probe/server.ts"],
  outdir: "dist",
  target: "bun",
  naming: "events-probe.js",
});
if (!probe.success)
  throw new AggregateError(probe.logs, "Event probe build failed");
const metafiles = [server.metafile!];
const css = await readFile(
  "node_modules/@openai/mcp-extensions/styles.css",
  "utf8",
);
for (const view of ["panel", "model-picker"]) {
  const bundle = await Bun.build({
    entrypoints: [`src/${view}.ts`],
    target: "browser",
    minify: true,
    metafile: true,
    loader: { ".svg": "text" },
  });
  if (!bundle.success || !bundle.outputs[0])
    throw new AggregateError(bundle.logs, `${view} build failed`);
  metafiles.push(bundle.metafile!);
  const script = (await bundle.outputs[0].text()).replaceAll(
    "</script",
    "<\\/script",
  );
  const styles =
    css +
    (await readFile("src/ui.css", "utf8")) +
    (await readFile(`src/${view}.css`, "utf8"));
  const html = (await readFile(`src/${view}.html`, "utf8"))
    .replace("/*SCRIPT*/", () => script)
    .replace("/*STYLES*/", () => styles);
  await writeFile(`dist/${view}.html`, html);
}

await writeNotices(metafiles);
