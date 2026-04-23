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

// Strip matching single or double quotes around a YAML scalar.
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
}

async function readConfigYaml(): Promise<{ server?: string; login?: string; maxColumns?: number }> {
  const paths = [
    join(homedir(), ".config", ".jira", ".config.yml"),
    join(homedir(), ".config", "jira", ".config.yml"),
  ];
  for (const p of paths) {
    const f = Bun.file(p);
    if (!(await f.exists())) continue;
    const text = await f.text();
    const out: { server?: string; login?: string; maxColumns?: number } = {};
    const server = /^server:\s*(.+)$/m.exec(text)?.[1];
    const login = /^login:\s*(.+)$/m.exec(text)?.[1];
    const maxCols = /^max_columns:\s*(.+)$/m.exec(text)?.[1];
    if (server) out.server = unquote(server);
    if (login) out.login = unquote(login);
    if (maxCols) {
      const n = Number.parseInt(unquote(maxCols), 10);
      if (Number.isFinite(n) && n >= 1) out.maxColumns = n;
    }
    return out;
  }
  return {};
}

const DEFAULT_MAX_VISIBLE_COLS = 4;

export async function loadConfig(): Promise<AppConfig> {
  const env = Bun.env;
  const yaml = await readConfigYaml();
  const server = env["JIRA_SERVER"] || yaml.server;
  const email = env["JIRA_LOGIN"] || env["JIRA_EMAIL"] || yaml.login;
  const token = env["JIRA_API_TOKEN"];
  if (!server)
    throw new Error("Missing Jira server (set JIRA_SERVER or ~/.config/.jira/.config.yml)");
  if (!email)
    throw new Error("Missing Jira login email (set JIRA_LOGIN or ~/.config/.jira/.config.yml)");
  if (!token) throw new Error("Missing JIRA_API_TOKEN environment variable");
  const authHeader = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

  const maxVisibleCols = yaml.maxColumns ?? DEFAULT_MAX_VISIBLE_COLS;

  return {
    jira: { server: server.replace(/\/$/, ""), authHeader },
    maxVisibleCols,
  };
}
