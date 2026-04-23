import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

export type JiraConfig = {
  server: string;
  authHeader: string;
};

export type AppConfig = {
  jira: JiraConfig;
  maxVisibleCols: number;
};

async function readConfigToml(): Promise<{ server?: string; login?: string; maxColumns?: number }> {
  const paths = [
    join(homedir(), ".config", ".jira", ".config.toml"),
    join(homedir(), ".config", "jira", ".config.toml"),
  ];
  for (const p of paths) {
    const f = Bun.file(p);
    if (!(await f.exists())) continue;
    const text = await f.text();
    const parsed = parseToml(text);
    const out: { server?: string; login?: string; maxColumns?: number } = {};
    if (typeof parsed["server"] === "string") out.server = parsed["server"];
    if (typeof parsed["login"] === "string") out.login = parsed["login"];
    if (typeof parsed["max_columns"] === "number" && parsed["max_columns"] >= 1) {
      out.maxColumns = Math.trunc(parsed["max_columns"]);
    }
    return out;
  }
  return {};
}

const DEFAULT_MAX_VISIBLE_COLS = 4;

export async function loadConfig(): Promise<AppConfig> {
  const env = Bun.env;
  const toml = await readConfigToml();
  const server = env["JIRA_SERVER"] || toml.server;
  const email = env["JIRA_LOGIN"] || env["JIRA_EMAIL"] || toml.login;
  const token = env["JIRA_API_TOKEN"];
  if (!server)
    throw new Error("Missing Jira server (set JIRA_SERVER or ~/.config/.jira/.config.toml)");
  if (!email)
    throw new Error("Missing Jira login email (set JIRA_LOGIN or ~/.config/.jira/.config.toml)");
  if (!token) throw new Error("Missing JIRA_API_TOKEN environment variable");
  const authHeader = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

  const maxVisibleCols = toml.maxColumns ?? DEFAULT_MAX_VISIBLE_COLS;

  return {
    jira: { server: server.replace(/\/$/, ""), authHeader },
    maxVisibleCols,
  };
}
