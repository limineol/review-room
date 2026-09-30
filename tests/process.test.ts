import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

async function fixture(source: string, expression: string) {
  const dir = await mkdtemp(join(tmpdir(), "review-room-process-"));
  try {
    const cli = join(dir, "claude");
    await writeFile(cli, `#!${process.execPath}\n${source}`);
    await chmod(cli, 0o700);
    const script = `import {invoke} from ${JSON.stringify(join(import.meta.dir, "../src/harness.ts"))}; const reviewer={name:'test',harness:'claude',model:'test',sessionId:null,state:'idle'}; const input={reviewer,repo:process.env.REVIEW_ROOM_TEST_DIR,prompt:'test',schemaFile:'/tmp/unused-schema',timeoutSeconds:30,activity:()=>{}}; ${expression}`;
    const processUnderTest = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        PATH: dir + delimiter + process.env.PATH,
        REVIEW_ROOM_TEST_DIR: dir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(processUnderTest.stdout).text();
    const errors = await new Response(processUnderTest.stderr).text();
    expect(await processUnderTest.exited).toBe(0);
    return {
      output,
      errors,
      childPid: await readFile(join(dir, "child.pid"), "utf8").catch(
        () => undefined,
      ),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("output limit reports its real cause", async () => {
  const result = await fixture(
    `process.stdout.write('x'.repeat(2_000_001)); setInterval(()=>{},1000);`,
    `try { await invoke({...input,signal:new AbortController().signal}); } catch(error) { console.log(error.message); }`,
  );
  expect(result.output).toContain("2 MB");
}, 10000);

test.skipIf(process.platform === "win32")(
  "cancellation stops CLI descendants before completing",
  async () => {
    const result = await fixture(
      `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(process.env.REVIEW_ROOM_TEST_DIR+'/child.pid',String(child.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,
      `const control=new AbortController(); setTimeout(()=>control.abort(),700); try { await invoke({...input,signal:control.signal}); } catch(error) { console.log(error.message); }`,
    );
    expect(result.output).toContain("Review cancelled");
    expect(result.childPid).toBeDefined();
    await Bun.sleep(100);
    expect(() => process.kill(Number(result.childPid), 0)).toThrow();
  },
  10000,
);

test("missing CLI history is distinguished from other provider errors", async () => {
  const result = await fixture(
    `console.error('Error: No conversation found with session ID'); process.exit(1);`,
    `try { await invoke({...input,reviewer:{...reviewer,sessionId:'00000000-0000-0000-0000-000000000000'},signal:new AbortController().signal}); } catch(error) { console.log(error.constructor.name); }`,
  );
  expect(result.output).toContain("MissingSessionError");
});
