import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { JiraConfig } from "./config";
import type { BoardConfig, Issue } from "./jira";

type CacheIdentity = {
  version: 1 | 2;
  server: string;
  authHash: string;
  boardId: number;
};

/** Recently-touched issues. Newest first. */
export type RecentIssue = { key: string; summary: string };

const writeQueues = new Map<string, Promise<void>>();

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cachePath(cfg: JiraConfig, boardId: number, recents = false): string {
  // The credential hash isolates users without putting credentials in a path.
  const readable = cfg.server.replaceAll(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suffix = recents ? "-recents" : "";
  const tail = `-${shortHash(cfg.server)}-user-${shortHash(cfg.authHeader)}-board-${boardId}${suffix}.json`;
  // Most filesystems allow 255 bytes per ASCII component. Only truncate names
  // that could not be created; the full-server hash keeps long prefixes unique.
  return join(homedir(), ".cache", "ifhj", `${readable.slice(0, 255 - tail.length)}${tail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoardConfig(value: unknown): value is BoardConfig {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    typeof value["projectKey"] !== "string" ||
    !Array.isArray(value["columns"])
  )
    return false;
  if (
    value["estimationFieldId"] !== undefined &&
    (typeof value["estimationFieldId"] !== "string" || value["estimationFieldId"].length === 0)
  )
    return false;
  return value["columns"].every(
    (column) =>
      isRecord(column) &&
      typeof column["name"] === "string" &&
      Array.isArray(column["statusIds"]) &&
      column["statusIds"].every((id) => typeof id === "string") &&
      (column["max"] === undefined ||
        (typeof column["max"] === "number" &&
          Number.isFinite(column["max"]) &&
          column["max"] >= 0)),
  );
}

function isIssue(value: unknown): value is Issue {
  if (!isRecord(value)) return false;
  const strings = [
    "key",
    "summary",
    "description",
    "statusId",
    "statusName",
    "statusCategory",
    "updated",
    "issueType",
  ];
  if (strings.some((key) => typeof value[key] !== "string")) return false;
  if (typeof value["id"] !== "number" || !Number.isFinite(value["id"])) return false;
  if (!Array.isArray(value["labels"]) || value["labels"].some((label) => typeof label !== "string"))
    return false;
  const optionalStrings = ["assignee", "priority", "epicKey", "sprintName", "startDate", "dueDate"];
  if (optionalStrings.some((key) => value[key] !== undefined && typeof value[key] !== "string"))
    return false;
  if (
    value["startDateState"] !== undefined &&
    value["startDateState"] !== "unavailable" &&
    value["startDateState"] !== "ambiguous" &&
    value["startDateState"] !== "invalid"
  )
    return false;
  if (value["dueDateState"] !== undefined && value["dueDateState"] !== "invalid") return false;
  return value["storyPoints"] === undefined || typeof value["storyPoints"] === "number";
}

function isRecentIssue(value: unknown): value is RecentIssue {
  return (
    isRecord(value) && typeof value["key"] === "string" && typeof value["summary"] === "string"
  );
}

function identity(cfg: JiraConfig, boardId: number, version: 1 | 2): CacheIdentity {
  return { version, server: cfg.server, authHash: shortHash(cfg.authHeader), boardId };
}

function hasIdentity(
  data: Record<string, unknown>,
  cfg: JiraConfig,
  boardId: number,
  version: 1 | 2,
): boolean {
  return (
    data["version"] === version &&
    data["server"] === cfg.server &&
    data["authHash"] === shortHash(cfg.authHeader) &&
    data["boardId"] === boardId
  );
}

async function readJson(path: string): Promise<unknown> {
  try {
    return await Bun.file(path).json();
  } catch {
    return undefined;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.ifhj-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temp, contents);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Serialize replacements for one cache key. This preserves invocation order,
 * so a slower old write cannot overwrite a newer state. Rename keeps readers
 * from observing a partial JSON file. */
async function queueWrite(path: string, contents: string): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => atomicWrite(path, contents));
  writeQueues.set(path, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(path) === current) writeQueues.delete(path);
  }
}

async function writeJson(path: string, data: object): Promise<void> {
  try {
    await queueWrite(path, JSON.stringify(data));
  } catch {
    // Cache I/O must never block the live Jira data path.
  }
}

export async function readBoardCache(
  cfg: JiraConfig,
  boardId: number,
): Promise<{ config: BoardConfig; issues: Issue[] } | null> {
  const data = await readJson(cachePath(cfg, boardId));
  if (
    !isRecord(data) ||
    !hasIdentity(data, cfg, boardId, 2) ||
    !isBoardConfig(data["config"]) ||
    !Array.isArray(data["issues"]) ||
    !data["issues"].every(isIssue)
  )
    return null;
  return { config: data["config"], issues: data["issues"] };
}

export async function writeBoardCache(
  cfg: JiraConfig,
  boardId: number,
  config: BoardConfig,
  issues: Issue[],
): Promise<void> {
  return writeJson(cachePath(cfg, boardId), { ...identity(cfg, boardId, 2), config, issues });
}

export async function readRecents(cfg: JiraConfig, boardId: number): Promise<RecentIssue[]> {
  const data = await readJson(cachePath(cfg, boardId, true));
  if (
    !isRecord(data) ||
    !hasIdentity(data, cfg, boardId, 1) ||
    !Array.isArray(data["recents"]) ||
    !data["recents"].every(isRecentIssue)
  )
    return [];
  return data["recents"];
}

export async function writeRecents(
  cfg: JiraConfig,
  boardId: number,
  recents: RecentIssue[],
): Promise<void> {
  return writeJson(cachePath(cfg, boardId, true), { ...identity(cfg, boardId, 1), recents });
}
