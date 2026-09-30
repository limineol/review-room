import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogs, readCatalog } from "../src/model-catalog";
import { ModelSettings } from "../src/model-settings";
import { Store } from "../src/store";
async function fixture(source: string, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
  try {
    const file = join(dir, "cli");
    await writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("Codex catalog initializes, paginates, filters hidden models and uses model slugs", async () => {
  await fixture(
    `
    let buffer = "";
    process.stdin.on("data", c => {
      buffer += c;
      let n;
      while ((n = buffer.indexOf("\\n")) >= 0) {
        const f = JSON.parse(buffer.slice(0,n)); buffer = buffer.slice(n+1);
        if (f.method === "initialize") console.log(JSON.stringify({id:f.id,result:{}}));
        if (f.method === "model/list") console.log(JSON.stringify({id:f.id,result:{
          data: f.params.cursor ? [{id:"opaque",model:"second",displayName:"Second",description:"Details"}] : [
            {id:"opaque",model:"first",displayName:"First"}, {model:"hidden",displayName:"Hidden",hidden:true}],
          nextCursor: f.params.cursor ? null : "next"
        }}));
      }
    });`,
    async (path) => {
      expect(await readCatalog("codex", path)).toEqual([
        { id: "first", name: "First", description: "" },
        { id: "second", name: "Second", description: "Details" },
      ]);
    },
  );
});
test("Claude control initialization returns friendly models without a user turn", async () => {
  await fixture(
    `process.stdin.once("data", c => {
    const f = JSON.parse(c);
    if (f.type !== "control_request" || f.request.subtype !== "initialize") process.exit(1);
    console.log(JSON.stringify({ type:"control_response", response:{ subtype:"success", request_id:f.request_id,
      response:{ models:[{value:"opus",displayName:"Opus",description:"Thorough reviews"}],account:{secret:"must not appear"} } } }));
  });`,
    async (path) => {
      expect(await readCatalog("claude", path)).toEqual([
        { id: "opus", name: "Opus", description: "Thorough reviews" },
      ]);
    },
  );
});
test("catalog timeout terminates a silent harness", async () => {
  await fixture(`setInterval(() => {}, 1000);`, async (path) => {
    await expect(readCatalog("claude", path, 50)).rejects.toThrow("timed out");
  });
});
test("failed refresh preserves last good catalog and selections; saving preserves other settings", async () => {
  let fail = false,
    calls = 0;
  const catalogs = new ModelCatalogs(async () => {
    calls++;
    if (fail) throw new Error("private provider diagnostic");
    return [{ id: "opus", name: "Opus", description: "" }];
  });
  const store = new Store(":memory:");
  store.updateSettings({ claudeModels: "old-model", reuseSessions: true });
  const settings = new ModelSettings(store, catalogs);
  await Promise.all([settings.read("claude"), settings.read("claude")]);
  expect(calls).toBe(1);
  fail = true;
  const state = await settings.read("claude", true);
  expect(state.stale).toBe(true);
  expect(state.choices[0]?.id).toBe("opus");
  expect(state.selected).toEqual(["old-model"]);
  expect((await settings.read("claude")).stale).toBe(true);
  expect(calls).toBe(2);
  expect(state.error).not.toContain("private provider");
  await settings.save("claude", ["old-model", "opus"]);
  expect(store.settings().reuseSessions).toBe(true);
  expect(store.settings().claudeEnabled).toBe(false);
  await expect(settings.save("claude", ["invented"])).rejects.toThrow(
    "no longer",
  );
  await settings.save("claude", []);
  expect(store.settings().claudeModels).toBe("");
  expect(calls).toBe(2);
});

test("model identifiers accept harness context aliases without allowing option injection", async () => {
  const { modelSchema } = await import("../src/schema");
  expect(modelSchema.parse("sonnet[1m]")).toBe("sonnet[1m]");
  expect(modelSchema.safeParse("--help").success).toBe(false);
});
