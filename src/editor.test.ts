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
      process.stdin.on("data", listener);
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
    expect(result.events.slice(0, 5)).toEqual([
      "raw:false",
      "pause",
      "screen:1",
      "screen:2",
      "raw:true",
    ]);
    expect(result.events.filter((event) => event === "resume").length).toBeGreaterThanOrEqual(1);
    expect({ raw: result.raw, listeners: result.listenerCount, entries: result.entries }).toEqual({
      raw: true,
      listeners: 1,
      entries: [],
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
