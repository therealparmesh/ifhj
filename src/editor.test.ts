import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isolatedEnv, makeTempDir, runScript } from "./test/utils";

const editorUrl = new URL("./editor.ts", import.meta.url).href;

type Mode = "success" | "editor-failure" | "spawn-failure" | "setup-failure" | "restore-failure";
type Result = {
  value?: string;
  error?: string;
  events: string[];
  raw: boolean;
  listenerCount: number;
  resizeListenerCount: number;
  resizeHandled: number;
  args?: string[];
  modes?: { directories: number[]; files: number[] };
  entries: string[];
};

async function runEditor(mode: Mode): Promise<Result> {
  const root = await makeTempDir("editor-'quoted'");
  const bin = join(root, "bin");
  const resultPath = join(root, "result.json");
  const reportPath = join(root, "editor-report.json");
  try {
    await mkdir(bin);
    const fakeEditor = join(bin, "nvim");
    await writeFile(
      fakeEditor,
      `#!${process.execPath}
        import { readdirSync, statSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const root = process.env.TMPDIR;
        const directories = readdirSync(root)
          .filter((name) => name.startsWith("ifhj-"))
          .map((name) => join(root, name));
        const files = directories.flatMap((dir) =>
          readdirSync(dir).map((name) => join(dir, name)),
        );
        writeFileSync(process.env.IFHJ_REPORT, JSON.stringify({
          args: process.argv.slice(2),
          modes: {
            directories: directories.map((path) => statSync(path).mode & 0o777),
            files: files.map((path) => statSync(path).mode & 0o777),
          },
        }));
        writeFileSync(process.argv.at(-1), "edited");
        process.exit(Number(process.env.IFHJ_EDITOR_EXIT));
      `,
    );
    await chmod(fakeEditor, 0o700);

    const source = `
      const { chmodSync, readdirSync, readFileSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { editInNeovim } = await import(${JSON.stringify(editorUrl)});
      const events = [];
      const listener = () => {};
      let resizeHandled = 0;
      const resizeListener = () => { resizeHandled++; events.push("resize-handled"); };
      process.stdin.on("data", listener);
      process.stdout.on("resize", resizeListener);
      let raw = true;
      Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => raw });
      process.stdin.setRawMode = (value) => { raw = value; events.push("raw:" + value); };
      process.stdin.pause = () => { events.push("pause"); return process.stdin; };
      process.stdin.resume = () => { events.push("resume"); return process.stdin; };
      let screenWrites = 0;
      process.stdout.write = () => {
        screenWrites++;
        events.push("screen:" + screenWrites);
        if (${JSON.stringify(mode)} === "restore-failure" && screenWrites === 2) {
          throw new Error("restore failed");
        }
        return true;
      };
      if (${JSON.stringify(mode)} === "spawn-failure") {
        Bun.spawn = () => { throw new Error("spawn failed"); };
      } else {
        const realSpawn = Bun.spawn;
        Bun.spawn = (...args) => {
          const child = realSpawn(...args);
          events.push("spawn-resize");
          process.stdout.emit("resize");
          return child;
        };
      }
      const user = ${JSON.stringify(mode)} === "setup-failure"
        ? {
            accountId: "id",
            get displayName() {
              const mentionDir = readdirSync(process.env.TMPDIR)
                .find((name) => name.startsWith("ifhj-mention-"));
              chmodSync(join(process.env.TMPDIR, mentionDir), 0o500);
              return "A ] Name";
            },
          }
        : { accountId: "id", displayName: "A ] Name" };
      const result = { events };
      try {
        result.value = await editInNeovim("initial", "../../unsafe.md", { mentionUsers: [user] });
      } catch (error) {
        result.error = error.message;
      }
      result.raw = raw;
      result.listenerCount = process.stdin.listeners("data").filter((item) => item === listener).length;
      result.resizeListenerCount = process.stdout.listeners("resize").filter((item) => item === resizeListener).length;
      result.resizeHandled = resizeHandled;
      try { Object.assign(result, JSON.parse(readFileSync(${JSON.stringify(reportPath)}, "utf8"))); }
      catch {}
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
    `;
    const { exitCode, stderr } = await runScript(source, {
      ...isolatedEnv(root),
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: root,
      IFHJ_REPORT: reportPath,
      IFHJ_EDITOR_EXIT: mode === "editor-failure" ? "7" : "0",
    });
    expect(exitCode, stderr).toBe(0);
    const result = (await Bun.file(resultPath).json()) as Result;
    result.entries = (await readdir(root)).filter((name) => name.startsWith("ifhj-")).toSorted();
    return result;
  } finally {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

describe("external editor lifecycle", () => {
  for (const editorExit of [0, 7]) {
    test(`real Ink readable ownership is suspended and restored when editor exits ${editorExit}`, async () => {
      const root = await makeTempDir(`ink-readable-${editorExit}`);
      try {
        const inputUrl = new URL("./input.tsx", import.meta.url).href;
        const source = `
          const React = await import(${JSON.stringify(new URL("../node_modules/react/index.js", import.meta.url).href)});
          const { render, Text } = await import(${JSON.stringify(new URL("../node_modules/ink/build/index.js", import.meta.url).href)});
          const { PassThrough } = await import("node:stream");
          const { useInput } = await import(${JSON.stringify(inputUrl)});
          let raw = true;
          Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
          process.stdin.setRawMode = (value) => { raw = value; };
          process.stdin.ref = () => {};
          process.stdin.unref = () => {};
          Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => raw });
          let appInputs = 0;
          let secondInputs = 0;
          function SecondInput() {
            useInput(() => { secondInputs++; });
            return null;
          }
          function Harness({ second = false }) {
            useInput(() => { appInputs++; });
            return React.createElement(React.Fragment, null,
              React.createElement(Text, null, "ready"),
              second ? React.createElement(SecondInput) : null,
            );
          }
          const app = render(React.createElement(Harness, { second: false }), {
            interactive: true,
            stdin: process.stdin,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            exitOnCtrlC: false,
            patchConsole: false,
          });
          await app.waitUntilRenderFlush();
          const before = process.stdin.listenerCount("readable");
          const originalRead = process.stdin.read.bind(process.stdin);
          const originalWrite = process.stdout.write;
          const queue = [];
          process.stdin.read = () => queue.shift() ?? null;
          process.stdout.write = () => true;
          Bun.which = (name) => name === "nvim" ? "/fake/nvim" : null;
          let during = -1;
          let duringHook = -1;
          let rawDuringHook = true;
          let childInput = "";
          Bun.spawn = () => {
            during = process.stdin.listenerCount("readable");
            const exited = (async () => {
              app.rerender(React.createElement(Harness, { second: true }));
              await app.waitUntilRenderFlush();
              duringHook = process.stdin.listenerCount("readable");
              rawDuringHook = raw;
              queue.push("child-key");
              childInput = String(process.stdin.read());
              app.rerender(React.createElement(Harness, { second: false }));
              await app.waitUntilRenderFlush();
              return ${editorExit};
            })();
            return { exitCode: ${editorExit}, exited };
          };
          const { editInNeovim } = await import(${JSON.stringify(editorUrl)});
          let failed = false;
          try { await editInNeovim("initial", "readable.md"); }
          catch { failed = true; }
          const after = process.stdin.listenerCount("readable");
          queue.push("app-key");
          process.stdin.emit("readable");
          await new Promise((resolve) => setImmediate(resolve));
          const rawAfterEdit = raw;
          process.stdin.read = originalRead;
          process.stdout.write = originalWrite;
          app.unmount();
          console.log(JSON.stringify({ before, during, duringHook, rawDuringHook, after, childInput, appInputs, secondInputs, rawAfterEdit, raw, failed }));
        `;
        const result = await runScript(source, {
          ...isolatedEnv(root),
          HOME: root,
          XDG_CACHE_HOME: join(root, ".cache"),
          XDG_CONFIG_HOME: join(root, ".config"),
          TMPDIR: root,
        });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          before: 1,
          during: 0,
          duringHook: 0,
          rawDuringHook: false,
          after: 1,
          childInput: "child-key",
          appInputs: 1,
          secondInputs: 0,
          rawAfterEdit: true,
          raw: false,
          failed: editorExit !== 0,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("editorLabel names the Vim fallback", async () => {
    const root = await makeTempDir("vim-fallback");
    const bin = join(root, "bin");
    try {
      await mkdir(bin);
      const vim = join(bin, "vim");
      await writeFile(vim, `#!${process.execPath}\nprocess.exit(0);\n`);
      await chmod(vim, 0o700);
      const { exitCode, stdout, stderr } = await runScript(
        `const { editorLabel } = await import(${JSON.stringify(editorUrl)}); console.log(editorLabel());`,
        { ...isolatedEnv(root), PATH: `${bin}:/usr/bin:/bin` },
      );
      expect(exitCode, stderr).toBe(0);
      expect(stdout.trim()).toBe("Vim");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves argument boundaries, private modes, input state, and cleanup", async () => {
    const result = await runEditor("success");
    expect(result.value).toBe("edited");
    expect(result.args).toHaveLength(5);
    expect(result.args?.[0]).toBe("--cmd");
    expect(result.args?.[1]).toMatch(/^execute 'source ' \. fnameescape\('.*''quoted''.*'\)$/);
    expect(result.args?.[2]).toBe("-c");
    expect(result.args?.[3]).toMatch(/^call IfhjMentionSetup\('.*''quoted''.*'\)$/);
    expect(result.args?.[4]).toMatch(/\/unsafe\.md$/);
    expect(result.modes).toEqual({ directories: [0o700, 0o700], files: [0o600, 0o600, 0o600] });
    expect(result.events.slice(0, 6)).toEqual([
      "raw:false",
      "pause",
      "screen:1",
      "spawn-resize",
      "screen:2",
      "raw:true",
    ]);
    expect(result.events.filter((event) => event === "resume").length).toBeGreaterThanOrEqual(1);
    expect(result.events.indexOf("resize-handled")).toBeGreaterThan(
      result.events.indexOf("screen:2"),
    );
    expect({ raw: result.raw, listeners: result.listenerCount, entries: result.entries }).toEqual({
      raw: true,
      listeners: 1,
      entries: [],
    });
    expect({ listeners: result.resizeListenerCount, handled: result.resizeHandled }).toEqual({
      listeners: 1,
      handled: 1,
    });
  });

  test("rejects editor and spawn failures without leaking state or files", async () => {
    const editorFailure = await runEditor("editor-failure");
    expect(editorFailure.error).toBe("Neovim exited with status 7");
    expect(editorFailure.entries).toEqual([]);
    expect(editorFailure.raw).toBe(true);

    const spawnFailure = await runEditor("spawn-failure");
    expect(spawnFailure.error).toBe("spawn failed");
    expect(spawnFailure.entries).toEqual([]);
    expect(spawnFailure.listenerCount).toBe(1);
  });

  test("cleans an edit directory when mention setup fails", async () => {
    const result = await runEditor("setup-failure");
    expect(result.error).toMatch(/permission denied|EACCES/i);
    expect(result.events).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  test("cleanup and input restoration continue after a screen restore failure", async () => {
    const result = await runEditor("restore-failure");
    expect(result.error).toBe("restore failed");
    expect(result.raw).toBe(true);
    expect(result.listenerCount).toBe(1);
    expect(result.events).toContain("resume");
    expect(result.entries).toEqual([]);
  });
});
