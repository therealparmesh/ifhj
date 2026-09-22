#!/usr/bin/env bun
/**
 * Cut a release. Runs from anywhere — paths resolve relative to this file.
 *
 *   ./scripts/release.ts patch   # 0.1.0 → 0.1.1
 *   ./scripts/release.ts minor   # 0.1.0 → 0.2.0
 *   ./scripts/release.ts major   # 0.1.0 → 1.0.0
 *   ./scripts/release.ts 1.2.3   # explicit
 *
 * Verifies the repository, bumps package.json, commits, tags v<version>, and pushes.
 * The `release` workflow picks up the tag and publishes the binaries.
 */

import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const pkgPath = resolve(repoRoot, "package.json");
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type PackageJson = Record<string, unknown> & { version?: unknown };
type ReleaseDependencies = {
  readPackage: () => Promise<PackageJson>;
  writePackage: (pkg: PackageJson) => Promise<unknown>;
  capture: (command: string[]) => Promise<string>;
  run: (command: string[]) => Promise<void>;
  log: (message: string) => void;
};

async function spawn(command: string[], stdout: "pipe" | "inherit"): Promise<string> {
  const child = Bun.spawn(command, { cwd: repoRoot, stdout, stderr: "inherit" });
  const output = stdout === "pipe" ? new Response(child.stdout).text() : Promise.resolve("");
  const [exitCode, text] = await Promise.all([child.exited, output]);
  if (exitCode !== 0) throw new Error(`command failed (${exitCode}): ${command.join(" ")}`);
  return text;
}

const defaultDependencies: ReleaseDependencies = {
  readPackage: () => Bun.file(pkgPath).json(),
  writePackage: (pkg) => Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`),
  capture: (command) => spawn(command, "pipe"),
  run: async (command) => {
    await spawn(command, "inherit");
  },
  log: console.log,
};

function parseVersion(value: unknown): [number, number, number] {
  if (typeof value !== "string") throw new Error("package.json has no valid version");
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`bad version: ${value}`);
  const parts = match.slice(1).map(Number) as [number, number, number];
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error(`bad version: ${value}`);
  return parts;
}

export function nextVersion(current: unknown, how: string): string {
  const [major, minor, patch] = parseVersion(current);
  if (how === "major" || how === "minor" || how === "patch") {
    const next =
      how === "major"
        ? `${major + 1}.0.0`
        : how === "minor"
          ? `${major}.${minor + 1}.0`
          : `${major}.${minor}.${patch + 1}`;
    parseVersion(next);
    return next;
  }

  const requested = parseVersion(how);
  const currentParts = [major, minor, patch];
  const difference = requested.findIndex((part, index) => part !== currentParts[index]);
  if (difference === -1 || requested[difference]! < currentParts[difference]!) {
    throw new Error(`release version must be greater than ${current}`);
  }
  return how;
}

export async function runRelease(
  args: string[],
  deps: ReleaseDependencies = defaultDependencies,
): Promise<void> {
  if (args.length !== 1) {
    throw new Error("usage: ./scripts/release.ts <patch|minor|major|x.y.z>");
  }

  const pkg = await deps.readPackage();
  const current = pkg.version;
  const next = nextVersion(current, args[0]!);
  const tag = `v${next}`;

  const status = (await deps.capture(["git", "status", "--porcelain"])).trim();
  if (status) throw new Error(`working tree is dirty:\n${status}`);
  if ((await deps.capture(["git", "tag", "--list", tag])).trim()) {
    throw new Error(`tag already exists: ${tag}`);
  }
  await deps.capture(["git", "remote", "get-url", "origin"]);
  const branch = (await deps.capture(["git", "branch", "--show-current"])).trim();
  if (!branch) throw new Error("cannot release from a detached HEAD");
  await deps.run(["bun", "install", "--frozen-lockfile"]);
  await deps.run(["bun", "run", "check"]);
  await deps.run(["bun", "run", "compile"]);

  deps.log(`bumping ${current} -> ${next}`);
  pkg.version = next;
  await deps.writePackage(pkg);
  await deps.run(["git", "add", "--", "package.json", "bun.lock"]);
  await deps.run(["git", "commit", "-m", `chore(release): ${tag}`]);
  await deps.run(["git", "tag", tag]);
  await deps.run([
    "git",
    "push",
    "--atomic",
    "origin",
    `HEAD:refs/heads/${branch}`,
    `refs/tags/${tag}`,
  ]);

  deps.log(`tagged ${tag}; GitHub Actions will build and publish it`);
}

if (import.meta.main) {
  try {
    await runRelease(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
