#!/usr/bin/env bun
/**
 * Cut a release. Runs from anywhere — paths resolve relative to this file.
 *
 *   ./scripts/release.ts patch   # 0.1.0 → 0.1.1
 *   ./scripts/release.ts minor   # 0.1.0 → 0.2.0
 *   ./scripts/release.ts major   # 0.1.0 → 1.0.0
 *   ./scripts/release.ts 1.2.3   # explicit
 *
 * Bumps package.json, resyncs bun.lock, commits, tags v<version>, pushes —
 * the `release` workflow picks up the tag and publishes the binaries.
 */

import { resolve } from "node:path";

import { $ } from "bun";

const repoRoot = resolve(import.meta.dir, "..");
$.cwd(repoRoot);

const arg = process.argv[2];
if (!arg) {
  console.error("usage: ./scripts/release.ts <patch|minor|major|x.y.z>");
  process.exit(1);
}

const pkgPath = resolve(repoRoot, "package.json");
const pkg = await Bun.file(pkgPath).json();
const current: string = pkg.version ?? "0.0.0";

const next = bump(current, arg);
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`✗ bad version: ${next}`);
  process.exit(1);
}

// Tags should describe a clean commit — bail if the tree is dirty.
const status = (await $`git status --porcelain`.text()).trim();
if (status) {
  console.error("✗ working tree is dirty — commit or stash first");
  console.error(status);
  process.exit(1);
}

console.log(`→ bumping ${current} → ${next}`);
pkg.version = next;
await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
// Resync bun.lock in case deps drifted since the last install.
await $`bun install`;

const tag = `v${next}`;
// -A so any side-effect files (e.g. a bun.lock resync) make it into the tag.
await $`git add -A`;
await $`git commit -m ${`chore(release): ${tag}`}`;
await $`git tag ${tag}`;
await $`git push`;
await $`git push origin ${tag}`;

console.log(`✓ tagged ${tag} — gh actions will build and publish`);

function bump(from: string, how: string): string {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [maj = 0, min = 0, pat = 0] = from.split(".").map(Number);
  if (how === "major") return `${maj + 1}.0.0`;
  if (how === "minor") return `${maj}.${min + 1}.0`;
  if (how === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`bad bump: ${how}`);
}
