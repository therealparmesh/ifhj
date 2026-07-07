import { homedir } from "node:os";
import { join } from "node:path";

import type { JiraConfig } from "./config";
import type { BoardConfig, Issue } from "./jira";

type BoardCache = {
  server: string;
  boardId: number;
  config: BoardConfig;
  issues: Issue[];
};

const CACHE_DIR = join(homedir(), ".cache", "ifhj");

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
    // No age check — the cache is for instant first paint, not correctness.
    // The caller always refreshes from the network in the background and swaps
    // fresh data in, so a stale cache only shows for the moment that fetch
    // takes. Discarding an old cache just to show a blank spinner defeats the
    // whole point. Server/board identity is still verified.
    if (data.server !== cfg.server || data.boardId !== boardId) return null;
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
    const data: BoardCache = { server: cfg.server, boardId, config, issues };
    await Bun.write(cachePath(cfg.server, boardId), JSON.stringify(data));
  } catch {}
}
