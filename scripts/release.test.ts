import { describe, expect, test } from "bun:test";

import { nextVersion, runRelease } from "./release";

type Command = string[];

function mockRelease(overrides: Record<string, unknown> = {}) {
  const captured: Command[] = [];
  const run: Command[] = [];
  const writes: unknown[] = [];
  const logs: string[] = [];
  const deps = {
    readPackage: async () => ({ name: "ifhj", version: "0.0.56" }),
    writePackage: async (pkg: unknown) => {
      writes.push(structuredClone(pkg));
    },
    capture: async (command: Command) => {
      captured.push(command);
      if (command[1] === "remote") return "git@example.test:ifhj.git\n";
      if (command[1] === "branch") return "main\n";
      return "";
    },
    run: async (command: Command) => {
      run.push(command);
    },
    log: (message: string) => logs.push(message),
    ...overrides,
  };
  return { deps, captured, run, writes, logs };
}

describe("release version validation", () => {
  test("accepts increments and rejects malformed or non-increasing versions", () => {
    expect(nextVersion("0.0.56", "patch")).toBe("0.0.57");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(nextVersion("0.0.56", "1.2.3")).toBe("1.2.3");
    expect(() => nextVersion("0.0.56", "0.0.56")).toThrow("must be greater");
    expect(() => nextVersion("0.0.56", "01.0.0")).toThrow("bad version");
    expect(() => nextVersion("invalid", "patch")).toThrow("bad version");
    expect(() => nextVersion("0.0.9007199254740991", "patch")).toThrow("bad version");
  });
});

describe("release side effects", () => {
  test("verifies first, stages only release files, and atomically pushes the commit and tag", async () => {
    const mock = mockRelease();
    await runRelease(["patch"], mock.deps);

    expect(mock.captured).toEqual([
      ["git", "status", "--porcelain"],
      ["git", "tag", "--list", "v0.0.57"],
      ["git", "remote", "get-url", "origin"],
      ["git", "branch", "--show-current"],
    ]);
    expect(mock.writes).toEqual([{ name: "ifhj", version: "0.0.57" }]);
    expect(mock.run).toEqual([
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "check"],
      ["bun", "run", "compile"],
      ["git", "add", "--", "package.json", "bun.lock"],
      ["git", "commit", "-m", "chore(release): v0.0.57"],
      ["git", "tag", "v0.0.57"],
      ["git", "push", "--atomic", "origin", "HEAD:refs/heads/main", "refs/tags/v0.0.57"],
    ]);
  });

  test.each(["check", "compile"])(
    "stops before writing the version when %s fails",
    async (step) => {
      const failure = new Error(`${step} failed`);
      const mock = mockRelease({
        run: async (command: Command) => {
          mock.run.push(command);
          if (command[0] === "bun" && command[2] === step) throw failure;
        },
      });

      await expect(runRelease(["patch"], mock.deps)).rejects.toBe(failure);
      expect(mock.run[0]).toEqual(["bun", "install", "--frozen-lockfile"]);
      expect(mock.writes).toEqual([]);
      expect(mock.run.some((command) => command[0] === "git")).toBe(false);
    },
  );

  test("checks the frozen lockfile before writing the version", async () => {
    const failure = new Error("lockfile is stale");
    const mock = mockRelease({
      run: async (command: Command) => {
        mock.run.push(command);
        if (command[0] === "bun" && command[1] === "install") throw failure;
      },
    });

    await expect(runRelease(["patch"], mock.deps)).rejects.toBe(failure);
    expect(mock.run).toEqual([["bun", "install", "--frozen-lockfile"]]);
    expect(mock.writes).toEqual([]);
    expect(mock.logs).toEqual([]);
  });

  test("stops after a staging failure without committing, tagging, pushing, or reporting success", async () => {
    const failure = new Error("git add failed");
    const mock = mockRelease({
      run: async (command: Command) => {
        mock.run.push(command);
        if (command[0] === "git" && command[1] === "add") throw failure;
      },
    });

    await expect(runRelease(["patch"], mock.deps)).rejects.toBe(failure);
    expect(mock.run).toEqual([
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "check"],
      ["bun", "run", "compile"],
      ["git", "add", "--", "package.json", "bun.lock"],
    ]);
    expect(mock.logs).toEqual(["bumping 0.0.56 -> 0.0.57"]);
  });

  test("rejects extra arguments before any repository command", async () => {
    const mock = mockRelease();
    await expect(runRelease(["patch", "extra"], mock.deps)).rejects.toThrow("usage:");
    expect(mock.captured).toEqual([]);
    expect(mock.run).toEqual([]);
  });
});
