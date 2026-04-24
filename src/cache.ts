import { homedir } from "node:os";
import { join } from "node:path";

import type { BoardConfig, Issue } from "./jira";

type BoardCache = {
  boardId: number;
  config: BoardConfig;
  issues: Issue[];
  ts: number;
};

const CACHE_DIR = join(homedir(), ".cache", "ifhj");
const MAX_AGE_MS = 10 * 60 * 1000;

function cachePath(boardId: number): string {
  return join(CACHE_DIR, `board-${boardId}.json`);
}

export async function readBoardCache(
  boardId: number,
): Promise<{ config: BoardConfig; issues: Issue[] } | null> {
  try {
    const f = Bun.file(cachePath(boardId));
    if (!(await f.exists())) return null;
    const data: BoardCache = await f.json();
    if (data.boardId !== boardId) return null;
    if (Date.now() - data.ts > MAX_AGE_MS) return null;
    return { config: data.config, issues: data.issues };
  } catch {
    return null;
  }
}

export async function writeBoardCache(
  boardId: number,
  config: BoardConfig,
  issues: Issue[],
): Promise<void> {
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(CACHE_DIR, { recursive: true });
    const data: BoardCache = { boardId, config, issues, ts: Date.now() };
    await Bun.write(cachePath(boardId), JSON.stringify(data));
  } catch {}
}
