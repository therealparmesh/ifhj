import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isolatedEnv, makeTempDir, runScript } from "./test/utils";

const editorUrl = new URL("./editor.ts", import.meta.url).href;

type Mode =
  | "success"
  | "editor-failure"
  | "unreadable"
  | "missing"
  | "directory-missing"
  | "draft-directory"
  | "inspection-denied"
  | "cleanup-failure"
  | "spawn-failure"
  | "setup-failure"
  | "restore-failure"
  | "editor-and-restore-failure";
type Result = {
  value?: string;
  error?: string;
  cause?: { message: string; code?: string };
  events: string[];
  raw: boolean;
  listenerCount: number;
  inputMethodsRestored: boolean;
  resizeListenerCount: number;
  resizeHandled: number;
  signalListenerCount: number;
  childSignals: string[];
  terminalResizes: string[];
  args?: string[];
  modes?: { directories: number[]; files: number[] };
  entries: string[];
  recoveryDirectories: string[];
  recoveryFiles: string[];
  recoveryKinds: string[];
  recoveryText: string[];
};

async function makeRemovable(path: string): Promise<void> {
  await chmod(path, 0o700).catch(() => {});
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await makeRemovable(join(path, entry.name));
  }
}

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
        import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
        import { dirname, join } from "node:path";
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
        if (process.env.IFHJ_EDITOR_ACTION === "unreadable") chmodSync(process.argv.at(-1), 0o000);
        if (process.env.IFHJ_EDITOR_ACTION === "missing") rmSync(process.argv.at(-1));
        if (process.env.IFHJ_EDITOR_ACTION === "directory-missing") {
          rmSync(dirname(process.argv.at(-1)), { recursive: true });
        }
        if (process.env.IFHJ_EDITOR_ACTION === "draft-directory") {
          rmSync(process.argv.at(-1));
          mkdirSync(process.argv.at(-1));
        }
        if (process.env.IFHJ_EDITOR_ACTION === "inspection-denied") {
          chmodSync(dirname(process.argv.at(-1)), 0o000);
        }
        if (process.env.IFHJ_EDITOR_ACTION === "cleanup-failure") {
          const blocked = join(dirname(process.argv.at(-1)), "blocked");
          mkdirSync(blocked);
          writeFileSync(join(blocked, "keep.txt"), "keep");
          chmodSync(blocked, 0o000);
        }
        process.exit(Number(process.env.IFHJ_EDITOR_EXIT));
      `,
    );
    await chmod(fakeEditor, 0o700);

    const source = `
      const { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { editInNeovim } = await import(${JSON.stringify(editorUrl)});
      const events = [];
      const listener = () => {};
      let resizeHandled = 0;
      const resizeListener = () => { resizeHandled++; events.push("resize-handled"); };
      process.stdin.on("data", listener);
      process.stdout.on("resize", resizeListener);
      const signalListenerCount = process.listenerCount("SIGWINCH");
      const inputMethods = {
        on: process.stdin.on,
        addListener: process.stdin.addListener,
        off: process.stdin.off,
        removeListener: process.stdin.removeListener,
      };
      const terminalResizes = [];
      const childSignals = [];
      let sttyCalls = 0;
      const realSpawnSync = Bun.spawnSync;
      Bun.spawnSync = (command, options) => command[0] === "stty"
        ? { exitCode: 0, stdout: Buffer.from(sttyCalls++ === 0 ? "24 80\\n" : "30 100\\n") }
        : realSpawnSync(command, options);
      let raw = true;
      Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => raw });
      process.stdin.setRawMode = (value) => { raw = value; events.push("raw:" + value); };
      process.stdin.pause = () => { events.push("pause"); return process.stdin; };
      process.stdin.resume = () => { events.push("resume"); return process.stdin; };
      let screenWrites = 0;
      process.stdout.write = () => {
        screenWrites++;
        events.push("screen:" + screenWrites);
        if (${JSON.stringify(mode)}.includes("restore-failure") && screenWrites === 2) {
          throw new Error("restore failed");
        }
        return true;
      };
      if (${JSON.stringify(mode)} === "spawn-failure") {
        Bun.spawn = () => { throw new Error("spawn failed"); };
      } else {
        const realSpawn = Bun.spawn;
        Bun.spawn = (...args) => {
          const terminal = args[1].terminal;
          terminal.resize = (cols, rows) => { terminalResizes.push(cols + "x" + rows); };
          const child = realSpawn(...args);
          const realKill = child.kill.bind(child);
          child.kill = (signal) => { childSignals.push(signal); return realKill(signal); };
          events.push("spawn-resize");
          queueMicrotask(() => process.emit("SIGWINCH"));
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
        if (error.cause instanceof Error) {
          result.cause = { message: error.cause.message, code: error.cause.code };
        }
      }
      result.raw = raw;
      result.listenerCount = process.stdin.listeners("data").filter((item) => item === listener).length;
      result.inputMethodsRestored = Object.entries(inputMethods)
        .every(([name, method]) => process.stdin[name] === method);
      result.resizeListenerCount = process.stdout.listeners("resize").filter((item) => item === resizeListener).length;
      result.resizeHandled = resizeHandled;
      result.signalListenerCount = process.listenerCount("SIGWINCH") - signalListenerCount;
      result.childSignals = childSignals;
      result.terminalResizes = terminalResizes;
      try { Object.assign(result, JSON.parse(readFileSync(${JSON.stringify(reportPath)}, "utf8"))); }
      catch {}
      const recoveryDirectories = readdirSync(process.env.TMPDIR)
        .filter((name) => name.startsWith("ifhj-edit-"))
        .map((name) => join(process.env.TMPDIR, name));
      for (const dir of recoveryDirectories) chmodSync(dir, 0o700);
      const recoveryFiles = recoveryDirectories.flatMap((dir) =>
        readdirSync(dir).map((name) => join(dir, name)),
      );
      const recoveryKinds = recoveryFiles.map((path) =>
        statSync(path).isFile() ? "file" : "directory",
      );
      const recoveryText = recoveryFiles.map((path) => {
        const mode = statSync(path).isDirectory() ? 0o700 : 0o600;
        try { chmodSync(path, mode); } catch {}
        if (statSync(path).isDirectory()) return "<directory>";
        try { return readFileSync(path, "utf8"); } catch (error) { return error.code; }
      });
      Object.assign(result, { recoveryDirectories, recoveryFiles, recoveryKinds, recoveryText });
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
    `;
    const { exitCode, stderr } = await runScript(source, {
      ...isolatedEnv(root),
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: root,
      IFHJ_REPORT: reportPath,
      IFHJ_EDITOR_EXIT:
        mode === "editor-failure" ||
        mode === "inspection-denied" ||
        mode === "editor-and-restore-failure"
          ? "7"
          : "0",
      IFHJ_EDITOR_ACTION: mode,
    });
    expect(exitCode, stderr).toBe(0);
    const result = (await Bun.file(resultPath).json()) as Result;
    result.entries = (await readdir(root)).filter((name) => name.startsWith("ifhj-")).toSorted();
    return result;
  } finally {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
}

function expectInputRestored(result: Result): void {
  expect(result.raw).toBe(true);
  expect(result.listenerCount).toBe(1);
  expect(result.inputMethodsRestored).toBe(true);
  expect(result.events).toContain("resume");
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
          Bun.spawn = (_command, { terminal }) => {
            terminal.write = (chunk) => { childInput += String(chunk); };
            during = process.stdin.listenerCount("readable");
            const exited = (async () => {
              app.rerender(React.createElement(Harness, { second: true }));
              await app.waitUntilRenderFlush();
              duringHook = process.stdin.listenerCount("readable");
              rawDuringHook = raw;
              queue.push("child-key");
              process.stdin.emit("readable");
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
          during: 1,
          duringHook: 1,
          rawDuringHook: true,
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
      "pause",
      "screen:1",
      "resume",
      "spawn-resize",
      "pause",
      "screen:2",
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
    expect(result.recoveryDirectories).toEqual([]);
    expect(result.recoveryFiles).toEqual([]);
    expect(result.inputMethodsRestored).toBe(true);
    expect({ listeners: result.resizeListenerCount, handled: result.resizeHandled }).toEqual({
      listeners: 1,
      handled: 1,
    });
    expect(result.signalListenerCount).toBe(0);
    expect(result.childSignals).toEqual(["SIGWINCH"]);
    expect(result.terminalResizes).toEqual(["100x30"]);
  });

  test("retains a saved draft after a nonzero editor exit", async () => {
    const editorFailure = await runEditor("editor-failure");
    expect(editorFailure.recoveryDirectories).toHaveLength(1);
    expect(editorFailure.recoveryFiles).toHaveLength(1);
    expect(editorFailure.error).toBe(
      `Neovim exited with status 7. Retained draft file: ${editorFailure.recoveryFiles[0]}`,
    );
    expect(editorFailure.cause).toEqual({ message: "Neovim exited with status 7" });
    expect(editorFailure.recoveryText).toEqual(["edited"]);
    expect(editorFailure.entries).toEqual([basename(editorFailure.recoveryDirectories[0]!)]);
    expectInputRestored(editorFailure);
  });

  test("cleans the edit directory after a synchronous spawn failure", async () => {
    const spawnFailure = await runEditor("spawn-failure");
    expect(spawnFailure.error).toBe("spawn failed");
    expect(spawnFailure.entries).toEqual([]);
    expect(spawnFailure.recoveryDirectories).toEqual([]);
    expectInputRestored(spawnFailure);
  });

  test("propagates an unreadable saved draft and retains its bytes", async () => {
    const result = await runEditor("unreadable");
    expect(result.recoveryDirectories).toHaveLength(1);
    expect(result.recoveryFiles).toHaveLength(1);
    expect(result.error).toBe(
      `${result.cause?.message}. Retained draft file: ${result.recoveryFiles[0]}`,
    );
    expect(result.cause?.code).toBe("EACCES");
    expect(result.recoveryText).toEqual(["edited"]);
    expect(result.entries).toEqual([basename(result.recoveryDirectories[0]!)]);
    expectInputRestored(result);
  });

  test("reports the retained directory when the editor removes the draft", async () => {
    const result = await runEditor("missing");
    expect(result.recoveryDirectories).toHaveLength(1);
    expect(result.recoveryFiles).toEqual([]);
    expect(result.recoveryText).toEqual([]);
    expect(result.cause?.code).toBe("ENOENT");
    expect(result.error).toBe(
      `${result.cause?.message}. Retained recovery directory: ${result.recoveryDirectories[0]}`,
    );
    expect(result.entries).toEqual([basename(result.recoveryDirectories[0]!)]);
    expectInputRestored(result);
  });

  test("does not claim recovery remains when the editor removes the whole directory", async () => {
    const result = await runEditor("directory-missing");
    const editPath = result.args?.at(-1);
    expect(editPath).toBeDefined();
    expect(result.recoveryDirectories).toEqual([]);
    expect(result.recoveryFiles).toEqual([]);
    expect(result.cause?.code).toBe("ENOENT");
    expect(result.error).toBe(
      `${result.cause?.message}. No recovery file or directory remains at: ${dirname(editPath!)}`,
    );
    expect(result.error).not.toContain("Retained");
    expect(result.entries).toEqual([]);
    expectInputRestored(result);
  });

  test("does not report a directory at the draft path as a retained file", async () => {
    const result = await runEditor("draft-directory");
    expect(result.recoveryDirectories).toHaveLength(1);
    expect(result.recoveryFiles).toHaveLength(1);
    expect(result.recoveryKinds).toEqual(["directory"]);
    expect(result.error).toBe(
      `${result.cause?.message}. Draft path is not a regular file: ${result.recoveryFiles[0]}. Retained recovery directory: ${result.recoveryDirectories[0]}`,
    );
    expect(result.error).not.toContain("Retained draft file");
    expect(result.entries).toEqual([basename(result.recoveryDirectories[0]!)]);
    expectInputRestored(result);
  });

  test("does not report recovery as absent when draft inspection is denied", async () => {
    const result = await runEditor("inspection-denied");
    const draftPath = result.recoveryFiles[0]!;
    const recoveryDir = result.recoveryDirectories[0]!;
    expect(result.error).toContain(
      `Could not fully inspect recovery paths. Draft path: ${draftPath}. Recovery directory: ${recoveryDir}. Inspection error: draft: EACCES:`,
    );
    expect(result.error).not.toContain("No recovery file or directory remains");
    expect(result.cause).toEqual({ message: "Neovim exited with status 7" });
    expect(result.recoveryText).toEqual(["edited"]);
    expectInputRestored(result);
  });

  test("returns saved text when only best-effort cleanup fails", async () => {
    const result = await runEditor("cleanup-failure");
    expect(result.value).toBe("edited");
    expect(result.error).toBeUndefined();
    expect(result.recoveryText).not.toContain("edited");
    expect(result.recoveryKinds).toEqual(["directory"]);
    expect(result.entries).toEqual([basename(result.recoveryDirectories[0]!)]);
    expectInputRestored(result);
  });

  test("cleans an edit directory when mention setup fails", async () => {
    const result = await runEditor("setup-failure");
    expect(result.error).toMatch(/permission denied|EACCES/i);
    expect(result.events).toEqual([]);
    expect(result.entries).toEqual([]);
    expect(result.recoveryDirectories).toEqual([]);
  });

  test("input restoration continues and the saved draft remains after a screen restore failure", async () => {
    const result = await runEditor("restore-failure");
    expect(result.recoveryFiles).toHaveLength(1);
    expect(result.error).toBe(`restore failed. Retained draft file: ${result.recoveryFiles[0]}`);
    expect(result.cause).toEqual({ message: "restore failed" });
    expect(result.recoveryText).toEqual(["edited"]);
    expect(result.entries).toEqual([basename(result.recoveryDirectories[0]!)]);
    expectInputRestored(result);
  });

  test("a restoration failure does not mask an earlier editor failure", async () => {
    const result = await runEditor("editor-and-restore-failure");
    expect(result.recoveryFiles).toHaveLength(1);
    expect(result.error).toBe(
      `Neovim exited with status 7. Retained draft file: ${result.recoveryFiles[0]}`,
    );
    expect(result.cause).toEqual({ message: "Neovim exited with status 7" });
    expect(result.recoveryText).toEqual(["edited"]);
    expectInputRestored(result);
  });
});
