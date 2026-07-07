import { homedir } from "node:os";
import { join } from "node:path";

import type { JiraConfig } from "./config";
import type { BoardConfig, Issue } from "./jira";

type BoardCache = {
  server: string;
  boardId: number;
  config: BoardConfig;
  issues: Issue[];
  ts: number;
};

const CACHE_DIR = join(homedir(), ".cache", "ifhj");
const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Board ids are small integers that collide across tenants, so the cache key
 * and payload both carry the server — otherwise switching `JIRA_SERVER` within
 * the TTL could surface tenant A's board as tenant B's. The slug is a readable
 * token plus an 8-char hash of the full URL, so two servers that flatten to
 * the same readable token still get distinct files.
 */
function serverSlug(server: string): string {
  const readable = server.replaceAll(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${readable}-${Bun.hash(server).toString(16).slice(0, 8)}`;
}

function cachePath(server: string, boardId: number): string {
  return join(CACHE_DIR, `${serverSlug(server)}-board-${boardId}.json`);
}

export async function readBoardCache(
  cfg: JiraConfig,
  boardId: number,
): Promise<{ config: BoardConfig; issues: Issue[] } | null> {
  try {
    const f = Bun.file(cachePath(cfg.server, boardId));
    if (!(await f.exists())) return null;
    const data: BoardCache = await f.json();
    if (data.server !== cfg.server || data.boardId !== boardId) return null;
    if (Date.now() - data.ts > MAX_AGE_MS) return null;
    return { config: data.config, issues: data.issues };
  } catch {
    return null;
  }
}

export async function writeBoardCache(
  cfg: JiraConfig,
  boardId: number,
  config: BoardConfig,
  issues: Issue[],
): Promise<void> {
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(CACHE_DIR, { recursive: true });
    const data: BoardCache = { server: cfg.server, boardId, config, issues, ts: Date.now() };
    await Bun.write(cachePath(cfg.server, boardId), JSON.stringify(data));
  } catch {}
}
