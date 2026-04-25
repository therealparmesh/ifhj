import { homedir } from "node:os";
import { join } from "node:path";

export type JiraConfig = {
  server: string;
  authHeader: string;
};

export type Settings = Record<string, unknown>;

const SETTINGS_PATH = join(homedir(), ".config", "ifhj", "settings.json");

export async function loadSettings(): Promise<Settings> {
  try {
    const f = Bun.file(SETTINGS_PATH);
    if (!(await f.exists())) return {};
    return (await f.json()) as Settings;
  } catch {
    return {};
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(homedir(), ".config", "ifhj"), { recursive: true });
  await Bun.write(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

// Strip matching single or double quotes around a YAML scalar.
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
}

async function readConfigYaml(): Promise<{ server?: string; login?: string }> {
  const paths = [
    join(homedir(), ".config", ".jira", ".config.yml"),
    join(homedir(), ".config", "jira", ".config.yml"),
  ];
  for (const p of paths) {
    const f = Bun.file(p);
    if (!(await f.exists())) continue;
    const text = await f.text();
    const out: { server?: string; login?: string } = {};
    const server = /^server:\s*(.+)$/m.exec(text)?.[1];
    const login = /^login:\s*(.+)$/m.exec(text)?.[1];
    if (server) out.server = unquote(server);
    if (login) out.login = unquote(login);
    return out;
  }
  return {};
}

export async function loadConfig(): Promise<JiraConfig> {
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
  return { server: server.replace(/\/$/, ""), authHeader };
}
