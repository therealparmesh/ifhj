import { homedir } from "node:os";
import { join } from "node:path";

export type JiraConfig = {
  server: string;
  authHeader: string;
};

export type AppConfig = {
  jira: JiraConfig;
  maxVisibleCols: number;
};

export function parseFlatToml(text: string): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (val.startsWith('"') || val.startsWith("'")) {
      const quote = val[0]!;
      const close = val.indexOf(quote, 1);
      if (close !== -1) {
        result[key] = val.slice(1, close);
        continue;
      }
    }
    const bare = val.replace(/#.*$/, "").trim();
    if (bare !== "" && Number.isFinite(Number(bare)))
      result[key] = Number(bare);
    else
      result[key] = bare;
  }
  return result;
}

async function readConfigToml(): Promise<{ server?: string; login?: string; maxColumns?: number }> {
  const legacyPaths = [
    join(homedir(), ".config", ".jira", ".config.yml"),
    join(homedir(), ".config", "jira", ".config.yml"),
  ];
  for (const p of legacyPaths) {
    if (await Bun.file(p).exists()) {
      console.warn(`Warning: found legacy YAML config at ${p} — rename to .config.toml (TOML format)`);
      break;
    }
  }
  const paths = [
    join(homedir(), ".config", ".jira", ".config.toml"),
    join(homedir(), ".config", "jira", ".config.toml"),
  ];
  for (const p of paths) {
    const f = Bun.file(p);
    if (!(await f.exists())) continue;
    const parsed = parseFlatToml(await f.text());
    const out: { server?: string; login?: string; maxColumns?: number } = {};
    if (typeof parsed["server"] === "string") out.server = parsed["server"];
    if (typeof parsed["login"] === "string") out.login = parsed["login"];
    if (typeof parsed["max_columns"] === "number" && parsed["max_columns"] >= 1) {
      out.maxColumns = Math.min(Math.trunc(parsed["max_columns"]), 20);
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
