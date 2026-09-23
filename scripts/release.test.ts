import { describe, expect, test } from "bun:test";

import { nextVersion, runRelease } from "./release";

type Command = string[];
type FailureStep = "install" | "check" | "compile" | "stage";

function commandStep(command: Command): FailureStep | undefined {
  if (command[0] === "bun" && command[1] === "install") return "install";
  if (command[0] === "bun" && command[1] === "run") {
    return command[2] === "check" || command[2] === "compile" ? command[2] : undefined;
  }
  if (command[0] === "git" && command[1] === "add") return "stage";
  return undefined;
}

function mockRelease(failAt?: FailureStep) {
  const captured: Command[] = [];
  const run: Command[] = [];
  const timeline: string[] = [];
  const deps = {
    readPackage: async () => ({ name: "ifhj", version: "0.0.56" }),
    writePackage: async (pkg: { version?: unknown }) => {
      timeline.push(`write:${pkg.version}`);
    },
    capture: async (command: Command) => {
      captured.push(command);
      if (command[1] === "remote") return "git@example.test:ifhj.git\n";
      if (command[1] === "branch") return "main\n";
      return "";
    },
    run: async (command: Command) => {
      run.push(command);
      const step = commandStep(command);
      if (failAt && step === failAt) throw new Error(`${failAt} failed`);
      if (step === "install" || step === "check" || step === "compile") {
        timeline.push(`gate:${step}`);
      } else if (command[1] === "tag") {
        timeline.push(`tag:${command[2]}`);
      } else {
        timeline.push(command[1] ?? "unknown");
      }
    },
    log: (message: string) => {
      if (message.startsWith("tagged ")) timeline.push("success");
    },
  };
  return { deps, captured, run, timeline };
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
  test("verifies first, stages only release files, and atomically pushes the branch and tag", async () => {
    const mock = mockRelease();
    await runRelease(["patch"], mock.deps);

    expect(mock.captured[0]).toEqual(["git", "status", "--porcelain"]);
    expect(mock.captured).toContainEqual(["git", "branch", "--show-current"]);
    expect(mock.run.find((command) => commandStep(command) === "install")).toEqual([
      "bun",
      "install",
      "--frozen-lockfile",
    ]);
    expect(mock.run.find((command) => commandStep(command) === "stage")).toEqual([
      "git",
      "add",
      "--",
      "package.json",
      "bun.lock",
    ]);
    expect(mock.run.at(-1)).toEqual([
      "git",
      "push",
      "--atomic",
      "origin",
      "HEAD:refs/heads/main",
      "refs/tags/v0.0.57",
    ]);
    expect(mock.timeline).toEqual([
      "gate:install",
      "gate:check",
      "gate:compile",
      "write:0.0.57",
      "add",
      "commit",
      "tag:v0.0.57",
      "push",
      "success",
    ]);
  });

  test.each(["install", "check", "compile"] as const)(
    "does not write or run Git when the %s gate fails",
    async (step) => {
      const mock = mockRelease(step);
      await expect(runRelease(["patch"], mock.deps)).rejects.toThrow(`${step} failed`);
      expect(mock.run.some((command) => command[0] === "git")).toBe(false);
      expect(
        mock.timeline.some((effect) => effect.startsWith("write:") || effect === "success"),
      ).toBe(false);
    },
  );

  test("stops after staging fails without commit, tag, push, or success output", async () => {
    const mock = mockRelease("stage");
    await expect(runRelease(["patch"], mock.deps)).rejects.toThrow("stage failed");
    expect(mock.run.at(-1)).toEqual(["git", "add", "--", "package.json", "bun.lock"]);
    expect(mock.run.some((command) => ["commit", "tag", "push"].includes(command[1] ?? ""))).toBe(
      false,
    );
    expect(mock.timeline).not.toContain("success");
  });

  test("rejects extra arguments before any repository command", async () => {
    const mock = mockRelease();
    await expect(runRelease(["patch", "extra"], mock.deps)).rejects.toThrow("usage:");
    expect(mock.captured).toEqual([]);
    expect(mock.run).toEqual([]);
  });
});
